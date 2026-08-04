import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { parseCsv, toCsv, sanitizeSegmentName } from './csv.js';
import {
  addLog,
  getTodayCreditsUsed,
  updateRun,
} from './db.js';
import { verifyBatch } from './providers/billionverify.js';
import { validateBulk } from './providers/no2bounce.js';
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
      status: 'verifying_bv',
      started_at: new Date().toISOString(),
      error_message: null,
    });
    await addLog(runId, 'Pipeline started');

    if (!run.upload_path) {
      throw new Error('Run has no upload_path');
    }

    const csvBuffer = await downloadFile(config.uploadsBucket, run.upload_path);
    const { records, columns, emailCol } = parseCsv(csvBuffer);
    const totalEmails = records.length;

    await updateRun(runId, { total_emails: totalEmails });
    await addLog(runId, `Loaded ${totalEmails} rows from CSV (email column: ${emailCol})`);

    // Credit ceiling check for BillionVerify
    const bvUsedToday = await getTodayCreditsUsed('bv_credits_used');
    const projectedBv = bvUsedToday + totalEmails;
    if (projectedBv > config.bvDailyCreditCeiling) {
      const msg =
        `BV credit ceiling pause: ${bvUsedToday} used today + ${totalEmails} projected = ${projectedBv} ` +
        `(ceiling ${config.bvDailyCreditCeiling}). Not starting Stage 1.`;
      await addLog(runId, `WARNING: ${msg}`);
      await updateRun(runId, {
        status: 'paused',
        error_message: msg,
      });
      return;
    }

    await addLog(
      runId,
      `Credit check OK — BV today ${bvUsedToday}/${config.bvDailyCreditCeiling}; starting Stage 1 (BillionVerify)`
    );

    // Stage 1 — BillionVerify
    const bvResults = new Map();
    let bvValid = 0;
    let bvCatchall = 0;
    let bvUnknown = 0;
    let bvInvalid = 0;
    let bvCredits = 0;
    let processed = 0;
    let lastLogAt = 0;

    for (let i = 0; i < records.length; i += config.bvBatchSize) {
      const batchRows = records.slice(i, i + config.bvBatchSize);
      const emails = batchRows
        .map((r) => String(r[emailCol] || '').trim())
        .filter(Boolean);

      const batchMap = await verifyBatch(emails);
      for (const [email, result] of batchMap.entries()) {
        bvResults.set(email, result);
        bvCredits += result.credits_used || 0;
        const status = result.status;
        if (status === 'valid') bvValid += 1;
        else if (status === 'catchall') bvCatchall += 1;
        else if (status === 'unknown') bvUnknown += 1;
        else bvInvalid += 1;
      }

      processed += batchRows.length;
      await updateRun(runId, {
        bv_valid_count: bvValid,
        bv_catchall_count: bvCatchall,
        bv_unknown_count: bvUnknown,
        bv_invalid_count: bvInvalid,
        bv_credits_used: bvCredits,
      });

      if (processed - lastLogAt >= 500 || processed >= totalEmails) {
        await addLog(
          runId,
          `BillionVerify progress: ${processed}/${totalEmails} ` +
            `(valid=${bvValid}, catchall=${bvCatchall}, unknown=${bvUnknown}, invalid=${bvInvalid}, credits=${bvCredits})`
        );
        lastLogAt = processed;
      }
    }

    // Stage 2 candidates
    const candidates = [];
    for (const row of records) {
      const email = String(row[emailCol] || '').trim().toLowerCase();
      const bv = bvResults.get(email);
      if (bv && (bv.status === 'unknown' || bv.status === 'catchall')) {
        candidates.push(email);
      }
    }

    await updateRun(runId, {
      status: 'verifying_n2b',
      n2b_candidates_count: candidates.length,
    });
    await addLog(
      runId,
      `Stage 1 complete. Sending ${candidates.length} unknown/catchall emails to no2bounce`
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
          bv_credits_used: bvCredits,
          n2b_candidates_count: candidates.length,
        });
        return;
      }

      await addLog(
        runId,
        `Credit check OK — no2bounce today ${n2bUsedToday}/${config.n2bDailyCreditCeiling}`
      );

      n2bResults = await validateBulk(candidates, {
        onProgress: async (message) => {
          await addLog(runId, message);
        },
      });

      for (const result of n2bResults.values()) {
        if (result.deliverable) n2bDeliverable += 1;
      }
      // no2bounce typically charges 1 credit per validated address
      n2bCredits = candidates.length;

      await updateRun(runId, {
        n2b_deliverable_count: n2bDeliverable,
        n2b_credits_used: n2bCredits,
      });
      await addLog(
        runId,
        `no2bounce complete: deliverable=${n2bDeliverable}/${candidates.length}, credits=${n2bCredits}`
      );
    } else {
      await addLog(runId, 'No unknown/catchall candidates — skipping no2bounce');
    }

    // Merge
    await updateRun(runId, { status: 'merging' });
    await addLog(runId, 'Merging results into SENDABLE / REJECTED CSVs');

    const outColumns = [
      ...columns.filter((c) => c !== 'verification_source' && c !== 'verification_status'),
      'verification_source',
      'verification_status',
    ];

    const sendable = [];
    const rejected = [];

    for (const row of records) {
      const email = String(row[emailCol] || '').trim().toLowerCase();
      const bv = bvResults.get(email) || { status: 'unknown' };
      const out = { ...row };

      if (bv.status === 'valid') {
        out.verification_source = 'billionverify';
        out.verification_status = 'valid';
        sendable.push(out);
      } else if (bv.status === 'unknown' || bv.status === 'catchall') {
        const n2b = n2bResults.get(email);
        if (n2b?.deliverable) {
          out.verification_source = 'no2bounce';
          out.verification_status = 'deliverable';
          sendable.push(out);
        } else {
          out.verification_source = n2b ? 'no2bounce' : 'billionverify';
          out.verification_status = n2b?.status || bv.status;
          rejected.push(out);
        }
      } else {
        out.verification_source = 'billionverify';
        out.verification_status = bv.status;
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
      bv_credits_used: bvCredits,
      n2b_credits_used: n2bCredits,
      n2b_deliverable_count: n2bDeliverable,
      sendable_path: sendablePath,
      rejected_path: rejectedPath,
      completed_at: new Date().toISOString(),
    });

    await addLog(
      runId,
      `Completed — sendable=${sendable.length}, rejected=${rejected.length}`
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

  // Prefer run-id namespaced path for clarity; keep original if rename fails
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
