import { parse } from 'csv-parse/sync';
import { config } from '../config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Current MillionVerifier credit balance.
 * GET https://api.millionverifier.com/api/v3/credits?api={key}
 */
export async function getCredits() {
  const url = `${config.millionVerifierCreditsUrl}?api=${encodeURIComponent(config.millionVerifierApiKey)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `MillionVerifier credits HTTP ${res.status}`);
  }
  // Prefer bulk_credits when present (bulk API draws from this pool)
  const credits = Number(
    body.bulk_credits ?? body.credits ?? body.credit ?? body.available ?? 0
  );
  return {
    credits,
    bulk_credits: Number(body.bulk_credits ?? credits),
    renewing_credits: Number(body.renewing_credits ?? 0),
    raw: body,
  };
}

/**
 * Build a minimal CSV for bulk upload (email column only — MV extracts emails).
 * Preserves original casing for matching via lowercase keys later.
 */
function emailsToCsv(emails) {
  const lines = ['Email', ...emails.map((e) => String(e).trim()).filter(Boolean)];
  return lines.join('\n');
}

/**
 * Stage 1 — MillionVerifier bulk verify.
 * Returns {
 *   results: Map<email, { result, quality, free, role }>,
 *   counts: { ok, catch_all, unknown, invalid },
 *   creditsUsed,
 *   fileId,
 *   fileinfo,
 * }
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

  const creditsBefore = await getCredits();

  const csv = emailsToCsv(unique);
  const form = new FormData();
  form.append('key', config.millionVerifierApiKey);
  // API expects `file_contents` (not `file`)
  form.append(
    'file_contents',
    new Blob([csv], { type: 'text/csv' }),
    filename
  );

  const uploadRes = await fetch(`${config.millionVerifierBulkUrl}/upload`, {
    method: 'POST',
    body: form,
  });
  const uploadBody = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploadBody.error) {
    throw new Error(
      uploadBody.error || uploadBody.message || `MillionVerifier upload HTTP ${uploadRes.status}`
    );
  }

  const fileId = uploadBody.file_id || uploadBody.fileId;
  if (!fileId) {
    throw new Error('MillionVerifier upload did not return file_id');
  }

  if (onProgress) {
    await onProgress(
      `MillionVerifier uploaded file_id=${fileId} (${unique.length} unique emails); credits before=${creditsBefore.credits}`
    );
  }

  let delayMs = 5_000;
  const maxDelay = 30_000;
  const deadline = Date.now() + 6 * 60 * 60 * 1000; // 6h — reverify can sit near the end
  let fileinfo = uploadBody;
  let lastLogKey = '';

  while (Date.now() < deadline) {
    const infoUrl =
      `${config.millionVerifierBulkUrl}/fileinfo` +
      `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
      `&file_id=${encodeURIComponent(fileId)}`;
    const infoRes = await fetch(infoUrl);
    fileinfo = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok || fileinfo.error) {
      throw new Error(
        fileinfo.error || fileinfo.message || `MillionVerifier fileinfo HTTP ${infoRes.status}`
      );
    }

    const status = String(fileinfo.status || '').toLowerCase();
    const percent = Number(fileinfo.percent ?? 0);
    const reverify = Number(fileinfo.reverify ?? 0);
    const logKey = `${status}|${percent}|${reverify}`;

    if (status === 'finished') {
      break;
    }

    if (['error', 'failed', 'canceled', 'cancelled'].includes(status)) {
      throw new Error(fileinfo.error || `MillionVerifier job failed: ${status}`);
    }

    // Near completion with reverify remaining is normal — keep polling, don't fail
    if (onProgress && logKey !== lastLogKey) {
      await onProgress(
        `MillionVerifier ${status} percent=${percent}` +
          (reverify ? ` reverify=${reverify}` : '') +
          ` (ok=${fileinfo.ok ?? 0}, catch_all=${fileinfo.catch_all ?? 0}, unknown=${fileinfo.unknown ?? 0}, invalid=${fileinfo.invalid ?? 0}); next poll ${Math.round(delayMs / 1000)}s`
      );
      lastLogKey = logKey;
    }

    await sleep(delayMs);
    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  if (String(fileinfo.status || '').toLowerCase() !== 'finished') {
    throw new Error('MillionVerifier polling timed out before status=finished');
  }

  const downloadUrl =
    `${config.millionVerifierBulkUrl}/download` +
    `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
    `&file_id=${encodeURIComponent(fileId)}` +
    `&filter=all`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) {
    const errText = await dlRes.text().catch(() => '');
    throw new Error(`MillionVerifier download HTTP ${dlRes.status}: ${errText.slice(0, 200)}`);
  }
  const csvText = await dlRes.text();
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
    let result = String(row.result || '').trim().toLowerCase();
    // Normalize synonyms
    if (result === 'catchall') result = 'catch_all';
    if (result === 'valid' || result === 'good') result = 'ok';
    if (!['ok', 'catch_all', 'unknown', 'invalid'].includes(result)) {
      // disposable etc. → treat as invalid for waterfall purposes
      if (result === 'disposable') result = 'invalid';
      else result = 'unknown';
    }
    results.set(email, {
      result,
      quality: String(row.quality || ''),
      free: String(row.free || ''),
      role: String(row.role || ''),
    });
    if (counts[result] !== undefined) counts[result] += 1;
  }

  // Prefer fileinfo tallies when download parse is incomplete
  if (
    Number(fileinfo.ok ?? 0) +
      Number(fileinfo.catch_all ?? 0) +
      Number(fileinfo.unknown ?? 0) +
      Number(fileinfo.invalid ?? 0) >
    0
  ) {
    // keep parsed counts; fileinfo is source of truth for logging
  }

  // Credits: MV does not charge catch_all/unknown — measure delta
  let creditsAfter;
  try {
    creditsAfter = await getCredits();
  } catch {
    creditsAfter = null;
  }

  let creditsUsed = Math.max(0, creditsBefore.credits - (creditsAfter?.credits ?? creditsBefore.credits));
  // Fallback to fileinfo.credit if delta is 0 but API reported a cost
  if (creditsUsed === 0 && Number(fileinfo.credit) > 0) {
    creditsUsed = Number(fileinfo.credit);
  }
  // Last resort: ok + invalid (charged categories)
  if (creditsUsed === 0) {
    const charged =
      Number(fileinfo.ok ?? counts.ok) + Number(fileinfo.invalid ?? counts.invalid);
    creditsUsed = charged;
  }

  if (onProgress) {
    await onProgress(
      `MillionVerifier finished file_id=${fileId}: ok=${fileinfo.ok ?? counts.ok}, ` +
        `catch_all=${fileinfo.catch_all ?? counts.catch_all}, unknown=${fileinfo.unknown ?? counts.unknown}, ` +
        `invalid=${fileinfo.invalid ?? counts.invalid}, credits_used=${creditsUsed}` +
        (creditsAfter ? ` (balance ${creditsBefore.credits}→${creditsAfter.credits})` : '')
    );
  }

  return {
    results,
    counts: {
      ok: Number(fileinfo.ok ?? counts.ok),
      catch_all: Number(fileinfo.catch_all ?? counts.catch_all),
      unknown: Number(fileinfo.unknown ?? counts.unknown),
      invalid: Number(fileinfo.invalid ?? counts.invalid),
    },
    creditsUsed,
    fileId: String(fileId),
    fileinfo,
  };
}
