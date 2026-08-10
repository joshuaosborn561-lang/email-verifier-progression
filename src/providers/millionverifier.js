import { parse } from 'csv-parse/sync';
import { config } from '../config.js';
import { VendorError, withRetry } from '../lib/retry.js';
import { normalizeMvResult } from '../merge.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Current MillionVerifier credit balance.
 * GET https://api.millionverifier.com/api/v3/credits?api={key}
 */
export async function getCredits() {
  const url = `${config.millionVerifierCreditsUrl}?api=${encodeURIComponent(config.millionVerifierApiKey)}`;
  const { value } = await withRetry(async () => {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new VendorError(
        body?.error || body?.message || `MillionVerifier credits HTTP ${res.status}`,
        { status: res.status, vendor: 'millionverifier' }
      );
    }
    return body;
  });

  const credits = Number(
    value.bulk_credits ?? value.credits ?? value.credit ?? value.available ?? 0
  );
  return {
    credits,
    bulk_credits: Number(value.bulk_credits ?? credits),
    renewing_credits: Number(value.renewing_credits ?? 0),
    raw: value,
  };
}

function emailsToCsv(emails) {
  const lines = ['Email', ...emails.map((e) => String(e).trim()).filter(Boolean)];
  return lines.join('\n');
}

/**
 * Credits charged by MillionVerifier for a finished file.
 * MV bills ok + invalid only (not catch_all/unknown). Prefer fileinfo tallies —
 * never use account balance deltas (concurrent runs corrupt that signal).
 */
export function computeMvCreditsUsed(fileinfo, counts) {
  const ok = Number(fileinfo?.ok ?? counts?.ok ?? 0);
  const invalid = Number(fileinfo?.invalid ?? counts?.invalid ?? 0);
  const chargedCategories = ok + invalid;

  const reported = Number(fileinfo?.credit ?? 0);
  // fileinfo.credit is sometimes unit cost (1); only trust it when it looks like a total
  if (reported > 1 && reported >= Math.floor(chargedCategories * 0.5)) {
    return reported;
  }
  return chargedCategories;
}

function parseMvCsv(csvText) {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  const results = new Map();
  const counts = { ok: 0, catch_all: 0, unknown: 0, invalid: 0 };

  for (const row of rows) {
    const email = String(row.Email || row.email || '').trim().toLowerCase();
    if (!email) continue;
    const result = normalizeMvResult(row.result);
    results.set(email, {
      result,
      quality: String(row.quality || ''),
      free: String(row.free || ''),
      role: String(row.role || ''),
    });
    if (counts[result] !== undefined) counts[result] += 1;
  }

  return { results, counts };
}

/**
 * Download + parse results for an existing MillionVerifier file_id (no re-upload / no re-charge).
 */
export async function downloadResultsByFileId(fileId, { onProgress } = {}) {
  if (!fileId) throw new Error('fileId is required');

  let delayMs = 5_000;
  const maxDelay = 30_000;
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  let fileinfo = null;

  while (Date.now() < deadline) {
    const infoUrl =
      `${config.millionVerifierBulkUrl}/fileinfo` +
      `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
      `&file_id=${encodeURIComponent(fileId)}`;

    const { value } = await withRetry(async () => {
      const infoRes = await fetch(infoUrl);
      const body = await infoRes.json().catch(() => ({}));
      if (!infoRes.ok || body.error) {
        throw new VendorError(
          body.error || body.message || `MillionVerifier fileinfo HTTP ${infoRes.status}`,
          { status: infoRes.status, vendor: 'millionverifier' }
        );
      }
      return body;
    });

    fileinfo = value;
    const status = String(fileinfo.status || '').toLowerCase();
    if (status === 'finished') break;
    if (['error', 'failed', 'canceled', 'cancelled'].includes(status)) {
      throw new VendorError(fileinfo.error || `MillionVerifier job failed: ${status}`, {
        vendor: 'millionverifier',
      });
    }
    if (onProgress) {
      await onProgress(
        `MillionVerifier file_id=${fileId} status=${status} percent=${fileinfo.percent ?? 0}`
      );
    }
    await sleep(delayMs);
    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  if (String(fileinfo?.status || '').toLowerCase() !== 'finished') {
    throw new Error('MillionVerifier polling timed out before status=finished');
  }

  const downloadUrl =
    `${config.millionVerifierBulkUrl}/download` +
    `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
    `&file_id=${encodeURIComponent(fileId)}` +
    `&filter=all`;

  const { value: csvText } = await withRetry(async () => {
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) {
      const errText = await dlRes.text().catch(() => '');
      throw new VendorError(
        `MillionVerifier download HTTP ${dlRes.status}: ${errText.slice(0, 200)}`,
        { status: dlRes.status, vendor: 'millionverifier' }
      );
    }
    return dlRes.text();
  });

  const { results, counts } = parseMvCsv(csvText);
  const mergedCounts = {
    ok: Number(fileinfo.ok ?? counts.ok),
    catch_all: Number(fileinfo.catch_all ?? counts.catch_all),
    unknown: Number(fileinfo.unknown ?? counts.unknown),
    invalid: Number(fileinfo.invalid ?? counts.invalid),
  };
  const fileinfoTotal =
    mergedCounts.ok + mergedCounts.catch_all + mergedCounts.unknown + mergedCounts.invalid;
  // Truncated downloads (common under concurrent fetch) must not be treated as full results
  if (fileinfoTotal > 0 && results.size < Math.floor(fileinfoTotal * 0.95)) {
    throw new VendorError(
      `MillionVerifier download incomplete for file_id=${fileId}: parsed ${results.size} rows vs fileinfo total ${fileinfoTotal} (csv bytes=${csvText.length})`,
      { transient: true, vendor: 'millionverifier' }
    );
  }

  const creditsUsed = computeMvCreditsUsed(fileinfo, mergedCounts);

  if (onProgress) {
    await onProgress(
      `MillionVerifier loaded file_id=${fileId}: ok=${mergedCounts.ok}, catch_all=${mergedCounts.catch_all}, ` +
        `unknown=${mergedCounts.unknown}, invalid=${mergedCounts.invalid}, parsed=${results.size}, credits_used=${creditsUsed}`
    );
  }

  return {
    results,
    counts: mergedCounts,
    creditsUsed,
    fileId: String(fileId),
    fileinfo,
  };
}

/**
 * Stage 1 — MillionVerifier bulk verify.
 */
export async function verifyBulk(emails, { onProgress, filename = 'verifyfall.csv' } = {}) {
  const unique = [...new Set(emails.map((e) => String(e).trim()).filter(Boolean))];
  if (!unique.length) {
    return {
      results: new Map(),
      counts: { ok: 0, catch_all: 0, unknown: 0, invalid: 0 },
      creditsUsed: 0,
      fileId: null,
      fileinfo: null,
    };
  }

  const csv = emailsToCsv(unique);

  const { value: uploadBody } = await withRetry(
    async () => {
      const form = new FormData();
      form.append('key', config.millionVerifierApiKey);
      form.append(
        'file_contents',
        new Blob([csv], { type: 'text/csv' }),
        filename
      );
      const uploadRes = await fetch(`${config.millionVerifierBulkUrl}/upload`, {
        method: 'POST',
        body: form,
      });
      const body = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok || body.error) {
        throw new VendorError(
          body.error || body.message || `MillionVerifier upload HTTP ${uploadRes.status}`,
          { status: uploadRes.status, vendor: 'millionverifier' }
        );
      }
      return body;
    },
    {
      onRetry: async ({ attempt, delay, error }) => {
        if (onProgress) {
          await onProgress(
            `MillionVerifier upload retry ${attempt} after: ${error.message} (wait ${Math.round(delay / 1000)}s)`
          );
        }
      },
    }
  );

  const fileId = uploadBody.file_id || uploadBody.fileId;
  if (!fileId) {
    throw new Error('MillionVerifier upload did not return file_id');
  }

  if (onProgress) {
    await onProgress(`MillionVerifier uploaded file_id=${fileId} (${unique.length} unique emails)`);
  }

  return downloadResultsByFileId(fileId, { onProgress });
}
