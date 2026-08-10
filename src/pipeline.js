import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { parseCsv, toCsv, sanitizeSegmentName } from './csv.js';
import {
  addLog,
  countAddressResultsByDisposition,
  getTodayCreditsUsed,
  listAddressResults,
  updateRun,
  upsertAddressResults,
} from './db.js';
import { mergeRunResults, resolveAddressOutcome } from './merge.js';
import {
  downloadResultsByFileId,
  getCredits,
  verifyBulk,
} from './providers/millionverifier.js';
import { validateCohorts } from './providers/no2bounce.js';
import {
  downloadFile,
  uploadFile,
} from './storage.js';

const activeJobs = new Set();

export function enqueueRun(runId, { resume = false } = {}) {
  if (activeJobs.has(runId)) return;
  activeJobs.add(runId);
  setImmediate(() => {
    runPipeline(runId, { resume })
      .catch((err) => {
        console.error(`Pipeline crashed for ${runId}:`, err);
      })
      .finally(() => {
        activeJobs.delete(runId);
      });
  });
}

async function failRun(runId, message, extra = {}) {
  await addLog(runId, `ERROR: ${message}`);
  await updateRun(runId, {
    status: 'failed',
    error_message: message,
    last_error: message,
    completed_at: new Date().toISOString(),
    ...extra,
  });
}

function buildAddressRowsFromMv(emails, mvResults) {
  const unique = [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  return unique.map((key) => {
    const mv = mvResults.get(key)?.result || 'unknown';
    const cohort = mv === 'catch_all' || mv === 'unknown' ? mv : null;
    const outcome = resolveAddressOutcome(mv, null);
    return {
      email: key,
      mv_result: mv,
      n2b_status: null,
      n2b_cohort: cohort,
      final_disposition: outcome.final_disposition,
      confidence: outcome.confidence,
      verification_source: outcome.verification_source,
    };
  });
}

function applyN2bToAddressRows(existingRows, n2bResults) {
  return existingRows.map((row) => {
    if (row.mv_result !== 'catch_all' && row.mv_result !== 'unknown') {
      return row;
    }
    const n2b = n2bResults.get(row.email);
    if (!n2b) return row;
    const outcome = resolveAddressOutcome(row.mv_result, n2b);
    return {
      ...row,
      n2b_status: n2b.status,
      n2b_cohort: row.n2b_cohort || row.mv_result,
      final_disposition: outcome.final_disposition,
      confidence: outcome.confidence,
      verification_source: outcome.verification_source,
    };
  });
}

function mvMapFromAddressRows(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.email, { result: row.mv_result || 'unknown' });
  }
  return map;
}

function n2bMapFromAddressRows(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.n2b_status) continue;
    map.set(row.email, {
      status: row.n2b_status,
      noVerdict: String(row.n2b_status).toLowerCase() === 'unknown',
    });
  }
  return map;
}

async function persistPartialCsvs(runId, segment, records, emailCol, columns, mvResults, n2bResults) {
  const merged = mergeRunResults({ records, emailCol, mvResults, n2bResults });
  // Only include rows that are fully resolved (not pending)
  const sendable = merged.sendable;
  const rejected = merged.rejected;

  const outColumns = [
    ...columns.filter(
      (c) =>
        c !== 'verification_source' &&
        c !== 'verification_status' &&
        c !== 'confidence'
    ),
    'verification_source',
    'verification_status',
    'confidence',
  ];

  const sendablePath = `${runId}/${segment}_SENDABLE.csv`;
  const rejectedPath = `${runId}/${segment}_REJECTED.csv`;

  await uploadFile(config.resultsBucket, sendablePath, toCsv(sendable, outColumns));
  await uploadFile(config.resultsBucket, rejectedPath, toCsv(rejected, outColumns));

  return {
    sendablePath,
    rejectedPath,
    sendableCount: sendable.length,
    rejectedCount: rejected.length,
    unresolvedAfterN2b: merged.unresolvedAfterN2b,
    confirmedCount: merged.confirmedCount,
    unresolvedCatchallCount: merged.unresolvedCatchallCount,
  };
}

async function runN2bStage({
  runId,
  catchAllEmails,
  unknownEmails,
  addressRows,
  priorCredits = 0,
  priorCatchAllSubmitted = 0,
  priorUnknownSubmitted = 0,
}) {
  const candidates = catchAllEmails.length + unknownEmails.length;
  const totalCatchAllSubmitted = priorCatchAllSubmitted + catchAllEmails.length;
  const totalUnknownSubmitted = priorUnknownSubmitted + unknownEmails.length;

  await updateRun(runId, {
    status: 'verifying_n2b',
    n2b_candidates_count: totalCatchAllSubmitted + totalUnknownSubmitted,
    n2b_catch_all_candidates: totalCatchAllSubmitted,
    n2b_unknown_candidates: totalUnknownSubmitted,
    last_error: null,
  });

  if (candidates === 0) {
    await addLog(runId, 'No catch_all/unknown candidates — skipping no2bounce');
    return {
      n2bResults: new Map(),
      n2bCredits: priorCredits,
      addressRows,
      catchAllConfirmed: 0,
      unknownConfirmed: 0,
    };
  }

  const n2bUsedToday = await getTodayCreditsUsed('n2b_credits_used');
  if (config.n2bDailyCreditCeiling > 0) {
    const projectedN2b = n2bUsedToday + candidates;
    if (projectedN2b > config.n2bDailyCreditCeiling) {
      const msg =
        `no2bounce credit ceiling pause: ${n2bUsedToday} used today + ${candidates} candidates = ${projectedN2b} ` +
        `(ceiling ${config.n2bDailyCreditCeiling}). Stopping before Stage 2.`;
      await addLog(runId, `WARNING: ${msg}`);
      await updateRun(runId, {
        status: 'paused',
        error_message: msg,
        last_error: msg,
        stage_completed: 'mv',
        n2b_candidates_count: totalCatchAllSubmitted + totalUnknownSubmitted,
      });
      return { paused: true };
    }
  }

  await addLog(
    runId,
    `Continuing full waterfall → no2bounce` +
      (config.n2bDailyCreditCeiling > 0
        ? ` (today ${n2bUsedToday}/${config.n2bDailyCreditCeiling})`
        : ` (today ${n2bUsedToday} credits used; ceiling disabled)`) +
      `; submitting catch_all=${catchAllEmails.length}, unknown=${unknownEmails.length} as separate cohorts`
  );

  let workingRows = addressRows;
  let creditsSoFar = priorCredits;

  const n2b = await validateCohorts({
    catchAllEmails,
    unknownEmails,
    onProgress: async (message) => {
      await addLog(runId, message);
    },
    onBatchComplete: async ({ batchResults, creditsUsed }) => {
      workingRows = applyN2bToAddressRows(workingRows, batchResults);
      await upsertAddressResults(runId, workingRows);
      creditsSoFar += creditsUsed;
      await updateRun(runId, {
        n2b_credits_used: creditsSoFar,
        // Keep stage at mv until all N2B batches finish — resume skips only completed addresses
        stage_completed: 'mv',
      });
    },
  });

  const updatedRows = applyN2bToAddressRows(workingRows, n2b.results);
  await upsertAddressResults(runId, updatedRows);

  let catchAllConfirmed = 0;
  let unknownConfirmed = 0;
  let n2bDeliverable = 0;
  for (const row of updatedRows) {
    if (!row.n2b_status) continue;
    const deliverable =
      row.final_disposition === 'sendable' && row.verification_source === 'no2bounce';
    if (!deliverable) continue;
    n2bDeliverable += 1;
    if (row.n2b_cohort === 'catch_all' || row.mv_result === 'catch_all') catchAllConfirmed += 1;
    if (row.n2b_cohort === 'unknown' || row.mv_result === 'unknown') unknownConfirmed += 1;
  }

  const totalCredits = priorCredits + n2b.creditsUsed;
  await updateRun(runId, {
    n2b_deliverable_count: n2bDeliverable,
    n2b_credits_used: totalCredits,
    n2b_catch_all_candidates: totalCatchAllSubmitted,
    n2b_catch_all_deliverable: catchAllConfirmed,
    n2b_unknown_candidates: totalUnknownSubmitted,
    n2b_unknown_deliverable: unknownConfirmed,
    stage_completed: 'n2b',
  });

  await addLog(
    runId,
    `no2bounce complete: deliverable=${n2bDeliverable} ` +
      `(catch_all confirmed=${catchAllConfirmed}/${totalCatchAllSubmitted}, ` +
      `unknown confirmed=${unknownConfirmed}/${totalUnknownSubmitted}), credits=${totalCredits}`
  );

  return {
    n2bResults: n2b.results,
    n2bCredits: totalCredits,
    addressRows: updatedRows,
    catchAllConfirmed,
    unknownConfirmed,
  };
}

async function runMergeStage({
  runId,
  run,
  records,
  emailCol,
  columns,
  mvResults,
  n2bResults,
  n2bCredits,
}) {
  await updateRun(runId, { status: 'merging' });
  await addLog(runId, 'Merging results into SENDABLE / REJECTED CSVs');

  const segment = sanitizeSegmentName(run.segment_name);
  const merged = await persistPartialCsvs(
    runId,
    segment,
    records,
    emailCol,
    columns,
    mvResults,
    n2bResults
  );

  // Finalize address dispositions
  const addressRows = [];
  for (const row of records) {
    const email = String(row[emailCol] || '').trim().toLowerCase();
    if (!email) continue;
    const mv = mvResults.get(email)?.result || 'unknown';
    const n2b = n2bResults.get(email) || null;
    const outcome = resolveAddressOutcome(mv, n2b);
    addressRows.push({
      email,
      mv_result: mv,
      n2b_status: n2b?.status ?? null,
      n2b_cohort: mv === 'catch_all' || mv === 'unknown' ? mv : null,
      final_disposition: outcome.final_disposition === 'pending' ? 'rejected' : outcome.final_disposition,
      confidence: outcome.confidence || 'rejected',
      verification_source: outcome.verification_source,
    });
  }
  await upsertAddressResults(runId, addressRows);

  await updateRun(runId, {
    status: 'completed',
    stage_completed: 'merge',
    final_sendable_count: merged.sendableCount,
    final_rejected_count: merged.rejectedCount,
    unresolved_after_n2b_count: merged.unresolvedAfterN2b,
    n2b_credits_used: n2bCredits,
    sendable_path: merged.sendablePath,
    rejected_path: merged.rejectedPath,
    completed_at: new Date().toISOString(),
    error_message: null,
    last_error: null,
  });

  await addLog(
    runId,
    `Completed — sendable=${merged.sendableCount} (confirmed=${merged.confirmedCount}, ` +
      `unresolved_catchall=${merged.unresolvedCatchallCount}), rejected=${merged.rejectedCount}, ` +
      `unresolved_after_n2b=${merged.unresolvedAfterN2b}`
  );
}

/**
 * Main pipeline. Supports resume from last completed stage.
 * - stage none / no mv_file_id → run MillionVerifier
 * - stage mv (or mv_file_id present) → skip MV, run N2B on pending cohorts
 * - stage n2b → skip to merge
 */
export async function runPipeline(runId, { resume = false } = {}) {
  let stageCompleted = 'none';
  try {
    const { getRun } = await import('./db.js');
    let run = await getRun(runId);
    if (!run) throw new Error('Run not found');

    stageCompleted = run.stage_completed || 'none';
    const canSkipMv =
      resume &&
      (stageCompleted === 'mv' ||
        stageCompleted === 'n2b' ||
        stageCompleted === 'merge' ||
        Boolean(run.mv_file_id));

    if (!run.upload_path) {
      throw new Error('Run has no upload_path');
    }

    const csvBuffer = await downloadFile(config.uploadsBucket, run.upload_path);
    const { records, columns, emailCol } = parseCsv(csvBuffer);
    const totalEmails = records.length;
    const emails = records
      .map((r) => String(r[emailCol] || '').trim())
      .filter(Boolean);

    await updateRun(runId, {
      total_emails: totalEmails,
      started_at: run.started_at || new Date().toISOString(),
      error_message: null,
    });

    let mvResults = new Map();
    let mvCredits = Number(run.mv_credits_used) || 0;
    let addressRows = [];

    // ── Stage 1: MillionVerifier ──────────────────────────────────────────
    if (canSkipMv && (run.mv_file_id || stageCompleted !== 'none')) {
      await addLog(
        runId,
        resume
          ? `Resume: skipping MillionVerifier (stage_completed=${stageCompleted}, mv_file_id=${run.mv_file_id || 'n/a'})`
          : `Reusing MillionVerifier results (mv_file_id=${run.mv_file_id})`
      );

      addressRows = await listAddressResults(runId);
      const expectedMvRows = Math.max(
        Number(run.total_emails) || 0,
        (Number(run.mv_ok_count) || 0) +
          (Number(run.mv_catch_all_count) || 0) +
          (Number(run.mv_unknown_count) || 0) +
          (Number(run.mv_invalid_count) || 0),
        emails.length
      );
      const tallies = { ok: 0, catch_all: 0, unknown: 0, invalid: 0 };
      for (const row of addressRows) {
        if (tallies[row.mv_result] !== undefined) tallies[row.mv_result] += 1;
      }
      const tallyClose = (got, expected) => {
        const exp = Number(expected) || 0;
        if (exp === 0) return got === 0;
        return Math.abs(got - exp) <= Math.max(25, Math.floor(exp * 0.05));
      };
      // Partial upserts OR truncated MV reloads leave wrong classifications — reload from MV file
      const coverageOk =
        addressRows.length > 0 &&
        addressRows.length >= Math.floor(expectedMvRows * 0.95) &&
        tallyClose(tallies.ok, run.mv_ok_count) &&
        tallyClose(tallies.catch_all, run.mv_catch_all_count) &&
        tallyClose(tallies.unknown, run.mv_unknown_count) &&
        tallyClose(tallies.invalid, run.mv_invalid_count);

      if (coverageOk) {
        mvResults = mvMapFromAddressRows(addressRows);
        await addLog(
          runId,
          `Resume: using ${addressRows.length} persisted address rows (expected ≈ ${expectedMvRows})`
        );
      } else if (run.mv_file_id) {
        await updateRun(runId, { status: 'verifying_mv' });
        await addLog(
          runId,
          `Resume: address coverage incomplete (${addressRows.length}/${expectedMvRows}) — reloading MillionVerifier file_id=${run.mv_file_id} (no re-charge)`
        );
        const mv = await downloadResultsByFileId(run.mv_file_id, {
          onProgress: async (message) => addLog(runId, message),
        });
        mvResults = mv.results;
        mvCredits = mv.creditsUsed;
        addressRows = buildAddressRowsFromMv(emails, mvResults);
        // Preserve any N2B fields already written for overlapping emails
        const priorByEmail = new Map(
          (await listAddressResults(runId)).map((r) => [r.email, r])
        );
        addressRows = addressRows.map((row) => {
          const prior = priorByEmail.get(row.email);
          if (!prior?.n2b_status) return row;
          return {
            ...row,
            n2b_status: prior.n2b_status,
            n2b_cohort: prior.n2b_cohort || row.n2b_cohort,
            final_disposition: prior.final_disposition || row.final_disposition,
            confidence: prior.confidence || row.confidence,
            verification_source: prior.verification_source || row.verification_source,
          };
        });
        await upsertAddressResults(runId, addressRows);
        await updateRun(runId, {
          mv_ok_count: mv.counts.ok,
          mv_catch_all_count: mv.counts.catch_all,
          mv_unknown_count: mv.counts.unknown,
          mv_invalid_count: mv.counts.invalid,
          mv_credits_used: mvCredits || run.mv_credits_used,
          mv_file_id: mv.fileId,
          stage_completed: 'mv',
        });
        stageCompleted = 'mv';
      } else {
        throw new Error('Cannot resume: no persisted address results and no mv_file_id');
      }
    } else {
      await updateRun(runId, { status: 'verifying_mv', last_error: null });
      await addLog(runId, 'Pipeline started (Stage 1 = MillionVerifier)');
      await addLog(runId, `Loaded ${totalEmails} rows from CSV (email column: ${emailCol})`);

      const balance = await getCredits();
      if (config.mvBalanceFractionCeiling > 0) {
        const projected = totalEmails;
        const ceiling = Math.floor(balance.credits * config.mvBalanceFractionCeiling);
        if (projected > ceiling) {
          const msg =
            `MillionVerifier credit ceiling pause: balance=${balance.credits}, ` +
            `${Math.round(config.mvBalanceFractionCeiling * 100)}% headroom=${ceiling}, ` +
            `projected worst-case=${projected}. Not starting Stage 1.`;
          await addLog(runId, `WARNING: ${msg}`);
          await updateRun(runId, {
            status: 'paused',
            error_message: msg,
            last_error: msg,
            stage_completed: 'none',
          });
          return;
        }
        await addLog(
          runId,
          `Credit check OK — MV balance ${balance.credits} (ceiling ${ceiling}); starting full waterfall`
        );
      } else {
        await addLog(
          runId,
          `Starting full waterfall — MV balance ${balance.credits} (credit ceilings disabled)`
        );
      }

      const mv = await verifyBulk(emails, {
        filename: `${sanitizeSegmentName(run.segment_name)}.csv`,
        onProgress: async (message) => {
          await addLog(runId, message);
        },
      });

      mvResults = mv.results;
      mvCredits = mv.creditsUsed;
      addressRows = buildAddressRowsFromMv(emails, mvResults);
      await upsertAddressResults(runId, addressRows);

      await updateRun(runId, {
        mv_ok_count: mv.counts.ok,
        mv_catch_all_count: mv.counts.catch_all,
        mv_unknown_count: mv.counts.unknown,
        mv_invalid_count: mv.counts.invalid,
        mv_credits_used: mvCredits,
        mv_file_id: mv.fileId,
        stage_completed: 'mv',
      });
      stageCompleted = 'mv';
      await addLog(
        runId,
        `Stage 1 complete and persisted (${addressRows.length} address rows). credits_used=${mvCredits}`
      );
    }

    run = await (await import('./db.js')).getRun(runId);

    // Refresh address rows if we loaded from DB earlier without full MV map coverage
    if (!addressRows.length) {
      addressRows = await listAddressResults(runId);
    }

    // ── Stage 2: No2Bounce (separate catch_all + unknown cohorts) ─────────
    let n2bResults = n2bMapFromAddressRows(addressRows);
    let n2bCredits = Number(run.n2b_credits_used) || 0;

    if (stageCompleted === 'n2b' || stageCompleted === 'merge') {
      await addLog(runId, `Resume: skipping No2Bounce (stage_completed=${stageCompleted})`);
    } else {
      // Only submit addresses still awaiting N2B
      const pendingCatchAll = [];
      const pendingUnknown = [];
      for (const row of addressRows) {
        if (row.n2b_status) continue;
        if (row.mv_result === 'catch_all') pendingCatchAll.push(row.email);
        else if (row.mv_result === 'unknown') pendingUnknown.push(row.email);
      }

      // Also include any emails from MV map not yet in address rows
      for (const [email, mvRow] of mvResults) {
        if (addressRows.some((r) => r.email === email)) continue;
        if (mvRow.result === 'catch_all') pendingCatchAll.push(email);
        else if (mvRow.result === 'unknown') pendingUnknown.push(email);
      }

      const alreadyCatchAll = addressRows.filter(
        (r) => r.mv_result === 'catch_all' && r.n2b_status
      ).length;
      const alreadyUnknown = addressRows.filter(
        (r) => r.mv_result === 'unknown' && r.n2b_status
      ).length;

      const n2bStage = await runN2bStage({
        runId,
        catchAllEmails: pendingCatchAll,
        unknownEmails: pendingUnknown,
        addressRows,
        priorCredits: Number(run.n2b_credits_used) || 0,
        priorCatchAllSubmitted: alreadyCatchAll,
        priorUnknownSubmitted: alreadyUnknown,
      });
      if (n2bStage.paused) return;

      n2bResults = n2bStage.n2bResults;
      n2bCredits = n2bStage.n2bCredits;
      // If some rows already had N2B from a prior partial attempt, merge maps
      for (const [email, value] of n2bMapFromAddressRows(addressRows)) {
        if (!n2bResults.has(email)) n2bResults.set(email, value);
      }
      addressRows = n2bStage.addressRows;
      stageCompleted = 'n2b';
    }

    // ── Stage 3: Merge ────────────────────────────────────────────────────
    await runMergeStage({
      runId,
      run,
      records,
      emailCol,
      columns,
      mvResults,
      n2bResults,
      n2bCredits,
    });
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`Run ${runId} failed:`, err);
    try {
      const { getRun } = await import('./db.js');
      const run = await getRun(runId);
      const nextRetry = (Number(run?.retry_count) || 0) + 1;
      // Preserve MV work — never wipe counts/file_id on N2B failure
      const preservedStage =
        run?.stage_completed && run.stage_completed !== 'none'
          ? run.stage_completed
          : stageCompleted;

      await failRun(runId, message, {
        retry_count: nextRetry,
        stage_completed: preservedStage || 'none',
        // keep completed_at for failed; clear only if we want resume UX
      });
    } catch (logErr) {
      console.error('Failed to persist failure state:', logErr);
    }
  }
}

export async function resumeVerification(runId, { force = false } = {}) {
  const { getRun } = await import('./db.js');
  const run = await getRun(runId);
  if (!run) throw new Error('Run not found');
  const resumable = ['failed', 'paused', 'queued'];
  if (force && run.status === 'completed') {
    // allow repair of completed-but-corrupt runs
  } else if (!resumable.includes(run.status)) {
    throw new Error(`Cannot resume run in status ${run.status}`);
  }

  const resume =
    Boolean(run.mv_file_id) ||
    ['mv', 'n2b', 'merge'].includes(run.stage_completed || 'none');

  await updateRun(runId, {
    status: 'queued',
    error_message: null,
    last_error: run.last_error || run.error_message,
    completed_at: null,
  });
  await addLog(
    runId,
    `Resume requested (resume=${resume}, stage_completed=${run.stage_completed || 'none'}, mv_file_id=${run.mv_file_id || 'n/a'})`
  );
  enqueueRun(runId, { resume });
  return getRun(runId);
}

export async function startVerificationFromBuffer({
  buffer,
  segmentName,
  filename = 'upload.csv',
}) {
  const segment = sanitizeSegmentName(segmentName || filename);
  const { records } = parseCsv(buffer);
  const runIdPlaceholder = randomUUID();
  const uploadPath = `${runIdPlaceholder}/${segment}.csv`;

  await uploadFile(config.uploadsBucket, uploadPath, buffer);

  const { createRun } = await import('./db.js');
  const run = await createRun({
    segmentName: segment,
    uploadPath,
    totalEmails: records.length,
  });

  const preferredPath = `${run.id}/${segment}.csv`;
  if (preferredPath !== uploadPath) {
    try {
      await uploadFile(config.uploadsBucket, preferredPath, buffer);
      await updateRun(run.id, { upload_path: preferredPath });
      run.upload_path = preferredPath;
    } catch {
      // keep original path
    }
  }

  await addLog(run.id, `Queued verification for segment "${segment}" (${records.length} emails)`);
  enqueueRun(run.id, { resume: false });
  return run;
}

export async function startVerificationFromUrl(fileUrl, segmentName) {
  const { downloadFromUrl } = await import('./storage.js');
  const buffer = await downloadFromUrl(fileUrl);
  return startVerificationFromBuffer({
    buffer,
    segmentName,
    filename: `${segmentName}.csv`,
  });
}

/**
 * Build a results payload for MCP/API — full when completed, partial otherwise.
 */
export async function buildResultsPayload(run) {
  const stageCounts = {
    stage_completed: run.stage_completed || 'none',
    mv_ok_count: run.mv_ok_count ?? 0,
    mv_catch_all_count: run.mv_catch_all_count ?? 0,
    mv_unknown_count: run.mv_unknown_count ?? 0,
    mv_invalid_count: run.mv_invalid_count ?? 0,
    n2b_candidates_count: run.n2b_candidates_count ?? 0,
    n2b_deliverable_count: run.n2b_deliverable_count ?? 0,
    n2b_catch_all_candidates: run.n2b_catch_all_candidates ?? 0,
    n2b_catch_all_deliverable: run.n2b_catch_all_deliverable ?? 0,
    n2b_unknown_candidates: run.n2b_unknown_candidates ?? 0,
    n2b_unknown_deliverable: run.n2b_unknown_deliverable ?? 0,
    unresolved_after_n2b_count: run.unresolved_after_n2b_count ?? 0,
    mv_credits_used: run.mv_credits_used ?? 0,
    n2b_credits_used: run.n2b_credits_used ?? 0,
  };

  let addressCounts = null;
  try {
    addressCounts = await countAddressResultsByDisposition(run.id);
  } catch {
    addressCounts = null;
  }

  const partial = run.status !== 'completed';
  const payload = {
    run_id: run.id,
    status: run.status,
    partial,
    segment_name: run.segment_name,
    total_emails: run.total_emails,
    final_sendable_count: run.final_sendable_count,
    final_rejected_count: run.final_rejected_count,
    last_error: run.last_error || run.error_message || null,
    retry_count: run.retry_count ?? 0,
    ...stageCounts,
    resolved_counts: addressCounts,
  };

  if (run.sendable_path && run.rejected_path) {
    const { createSignedUrl } = await import('./storage.js');
    const [sendable_url, rejected_url] = await Promise.all([
      createSignedUrl(config.resultsBucket, run.sendable_path),
      createSignedUrl(config.resultsBucket, run.rejected_path),
    ]);
    payload.sendable_url = sendable_url;
    payload.rejected_url = rejected_url;
  } else if (partial && addressCounts && addressCounts.total > 0) {
    // Generate partial CSVs from persisted address rows + original upload
    try {
      const csvBuffer = await downloadFile(config.uploadsBucket, run.upload_path);
      const { records, columns, emailCol } = parseCsv(csvBuffer);
      const addressRows = await listAddressResults(run.id);
      const mvResults = mvMapFromAddressRows(addressRows);
      const n2bResults = n2bMapFromAddressRows(addressRows);
      // For pending N2B rows, include them as unresolved rejected in partial export
      const n2bForMerge = new Map(n2bResults);
      for (const row of addressRows) {
        if (
          (row.mv_result === 'catch_all' || row.mv_result === 'unknown') &&
          !n2bForMerge.has(row.email)
        ) {
          // leave without N2B → merge treats as pending → rejected in mergeRunResults
        }
      }
      const segment = sanitizeSegmentName(run.segment_name);
      const files = await persistPartialCsvs(
        run.id,
        segment,
        records,
        emailCol,
        columns,
        mvResults,
        n2bForMerge
      );
      await updateRun(run.id, {
        sendable_path: files.sendablePath,
        rejected_path: files.rejectedPath,
        final_sendable_count: files.sendableCount,
        final_rejected_count: files.rejectedCount,
      });
      const { createSignedUrl } = await import('./storage.js');
      const [sendable_url, rejected_url] = await Promise.all([
        createSignedUrl(config.resultsBucket, files.sendablePath),
        createSignedUrl(config.resultsBucket, files.rejectedPath),
      ]);
      payload.sendable_url = sendable_url;
      payload.rejected_url = rejected_url;
      payload.final_sendable_count = files.sendableCount;
      payload.final_rejected_count = files.rejectedCount;
      payload.partial_note =
        'Partial results from completed stages only; addresses awaiting No2Bounce are listed under rejected/pending.';
    } catch (err) {
      payload.partial_note = `Address-level results available in DB; CSV generation deferred: ${err.message}`;
    }
  }

  return payload;
}
