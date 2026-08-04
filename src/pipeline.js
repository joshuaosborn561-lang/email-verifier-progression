import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { parseCsv, toCsv, sanitizeSegmentName } from './csv.js';
import {
  addLog,
  getTodayCreditsUsed,
  updateRun,
} from './db.js';
import { getCredits, verifyBulk } from './providers/millionverifier.js';
import {
  isAcceptAllDeliverable,
  isStrictDeliverable,
  validateBulk,
} from './providers/no2bounce.js';
import {
  downloadFile,
  uploadFile,
} from './storage.js';

const activeJobs = new Set();

export function enqueueRun(runId) {
  if (activeJobs.has(runId)) return;
  activeJobs.add(runId);
  setImmediate(() => {
    runPipeline(runId)
      .catch((err) => {
        console.error(`Pipeline crashed for ${runId}:`, err);
      })
      .finally(() => {
        activeJobs.delete(runId);
      });
  });
}

async function failRun(runId, message) {
  await addLog(runId, `ERROR: ${message}`);
  await updateRun(runId, {
    status: 'failed',
    error_message: message,
    completed_at: new Date().toISOString(),
  });
}

async function runPipeline(runId) {
  try {
    const { getRun } = await import('./db.js');
    const run = await getRun(runId);
    if (!run) throw new Error('Run not found');

    await updateRun(runId, {
      status: 'verifying_mv',
      started_at: new Date().toISOString(),
      error_message: null,
    });
    await addLog(runId, 'Pipeline started (Stage 1 = MillionVerifier)');

    if (!run.upload_path) {
      throw new Error('Run has no upload_path');
    }

    const csvBuffer = await downloadFile(config.uploadsBucket, run.upload_path);
    const { records, columns, emailCol } = parseCsv(csvBuffer);
    const totalEmails = records.length;

    await updateRun(runId, { total_emails: totalEmails });
    await addLog(runId, `Loaded ${totalEmails} rows from CSV (email column: ${emailCol})`);

    // Credit ceiling — MV balance: pause if projected usage > 50% of remaining
    // Worst-case projection = all emails charged (ok/invalid only bill, but unknown beforehand)
    const balance = await getCredits();
    const projected = totalEmails;
    const ceiling = Math.floor(balance.credits * config.mvBalanceFractionCeiling);
    if (projected > ceiling) {
      const msg =
        `MillionVerifier credit ceiling pause: balance=${balance.credits}, ` +
        `50% headroom=${ceiling}, projected worst-case=${projected}. Not starting Stage 1.`;
      await addLog(runId, `WARNING: ${msg}`);
      await updateRun(runId, {
        status: 'paused',
        error_message: msg,
      });
      return;
    }

    await addLog(
      runId,
      `Credit check OK — MV balance ${balance.credits} (50% ceiling ${ceiling}); starting Stage 1`
    );

    const emails = records
      .map((r) => String(r[emailCol] || '').trim())
      .filter(Boolean);

    const mv = await verifyBulk(emails, {
      filename: `${sanitizeSegmentName(run.segment_name)}.csv`,
      onProgress: async (message) => {
        await addLog(runId, message);
      },
    });

    await updateRun(runId, {
      mv_ok_count: mv.counts.ok,
      mv_catch_all_count: mv.counts.catch_all,
      mv_unknown_count: mv.counts.unknown,
      mv_invalid_count: mv.counts.invalid,
      mv_credits_used: mv.creditsUsed,
      mv_file_id: mv.fileId,
    });

    // Stage 2 candidates = catch_all + unknown
    const candidates = [];
    for (const row of records) {
      const email = String(row[emailCol] || '').trim().toLowerCase();
      const result = mv.results.get(email)?.result;
      if (result === 'catch_all' || result === 'unknown') {
        candidates.push(email);
      }
    }

    await updateRun(runId, {
      status: 'verifying_n2b',
      n2b_candidates_count: candidates.length,
    });
    await addLog(
      runId,
      `Stage 1 complete. Sending ${candidates.length} catch_all/unknown emails to no2bounce`
    );

    let n2bResults = new Map();
    let n2bDeliverable = 0;
    let n2bCredits = 0;

    if (candidates.length > 0) {
      const n2bUsedToday = await getTodayCreditsUsed('n2b_credits_used');
      const projectedN2b = n2bUsedToday + candidates.length;
      if (projectedN2b > config.n2bDailyCreditCeiling) {
        const msg =
          `no2bounce credit ceiling pause: ${n2bUsedToday} used today + ${candidates.length} candidates = ${projectedN2b} ` +
          `(ceiling ${config.n2bDailyCreditCeiling}). Stopping before Stage 2.`;
        await addLog(runId, `WARNING: ${msg}`);
        await updateRun(runId, {
          status: 'paused',
          error_message: msg,
          mv_credits_used: mv.creditsUsed,
          n2b_candidates_count: candidates.length,
        });
        return;
      }

      await addLog(
        runId,
        `Credit check OK — no2bounce today ${n2bUsedToday}/${config.n2bDailyCreditCeiling}`
      );

      const n2b = await validateBulk(candidates, {
        onProgress: async (message) => {
          await addLog(runId, message);
        },
      });
      n2bResults = n2b.results;
      n2bCredits = n2b.creditsUsed;

      for (const result of n2bResults.values()) {
        if (result.deliverable) n2bDeliverable += 1;
      }

      await updateRun(runId, {
        n2b_deliverable_count: n2bDeliverable,
        n2b_credits_used: n2bCredits,
      });
      await addLog(
        runId,
        `no2bounce complete: deliverable=${n2bDeliverable}/${candidates.length}, credits=${n2bCredits}`
      );
    } else {
      await addLog(runId, 'No catch_all/unknown candidates — skipping no2bounce');
    }

    // Merge
    await updateRun(runId, { status: 'merging' });
    await addLog(runId, 'Merging results into SENDABLE / REJECTED CSVs');

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

    const sendable = [];
    const rejected = [];
    let confirmedCount = 0;
    let unresolvedCatchallCount = 0;

    for (const row of records) {
      const email = String(row[emailCol] || '').trim().toLowerCase();
      const mvRow = mv.results.get(email) || { result: 'unknown' };
      const out = { ...row };

      if (mvRow.result === 'ok') {
        out.verification_source = 'millionverifier';
        out.verification_status = 'ok';
        out.confidence = 'confirmed';
        sendable.push(out);
        confirmedCount += 1;
      } else if (mvRow.result === 'catch_all' || mvRow.result === 'unknown') {
        const n2b = n2bResults.get(email);
        if (n2b && isStrictDeliverable(n2b.status)) {
          out.verification_source = 'no2bounce';
          out.verification_status = n2b.status;
          out.confidence = 'confirmed';
          sendable.push(out);
          confirmedCount += 1;
        } else if (n2b && isAcceptAllDeliverable(n2b.status)) {
          out.verification_source = 'no2bounce';
          out.verification_status = n2b.status;
          out.confidence = 'unresolved_catchall';
          sendable.push(out);
          unresolvedCatchallCount += 1;
        } else {
          out.verification_source = n2b ? 'no2bounce' : 'millionverifier';
          out.verification_status = n2b?.status || mvRow.result;
          out.confidence = 'rejected';
          rejected.push(out);
        }
      } else {
        out.verification_source = 'millionverifier';
        out.verification_status = mvRow.result;
        out.confidence = 'rejected';
        rejected.push(out);
      }
    }

    const segment = sanitizeSegmentName(run.segment_name);
    const sendablePath = `${runId}/${segment}_SENDABLE.csv`;
    const rejectedPath = `${runId}/${segment}_REJECTED.csv`;

    await uploadFile(
      config.resultsBucket,
      sendablePath,
      toCsv(sendable, outColumns)
    );
    await uploadFile(
      config.resultsBucket,
      rejectedPath,
      toCsv(rejected, outColumns)
    );

    await updateRun(runId, {
      status: 'completed',
      final_sendable_count: sendable.length,
      final_rejected_count: rejected.length,
      mv_credits_used: mv.creditsUsed,
      n2b_credits_used: n2bCredits,
      n2b_deliverable_count: n2bDeliverable,
      sendable_path: sendablePath,
      rejected_path: rejectedPath,
      completed_at: new Date().toISOString(),
    });

    await addLog(
      runId,
      `Completed — sendable=${sendable.length} (confirmed=${confirmedCount}, unresolved_catchall=${unresolvedCatchallCount}), rejected=${rejected.length}`
    );
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`Run ${runId} failed:`, err);
    try {
      await failRun(runId, message);
    } catch (logErr) {
      console.error('Failed to persist failure state:', logErr);
    }
  }
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
  enqueueRun(run.id);
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
