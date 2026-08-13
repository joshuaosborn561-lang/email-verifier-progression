import { parse } from 'csv-parse/sync';
import { config } from '../config.js';
import { VendorError, withRetry } from '../lib/retry.js';
import { normalizeMvResult } from '../merge.js';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = Object.assign(new Error('MillionVerifier poll aborted'), { name: 'AbortError' });
    throw err;
  }
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

export function isMvFileFinished(fileinfo) {
  const status = String(fileinfo?.status || '').toLowerCase();
  if (status === 'finished') return true;
  const percent = Number(fileinfo?.percent ?? 0);
  const reverify = Number(fileinfo?.reverify ?? 0);
  const tallied =
    Number(fileinfo?.ok ?? 0) +
    Number(fileinfo?.catch_all ?? 0) +
    Number(fileinfo?.unknown ?? 0) +
    Number(fileinfo?.invalid ?? 0);
  // Some jobs linger in in_progress after work is done; accept terminal-looking state
  return percent >= 100 && reverify === 0 && tallied > 0;
}

function progressKey(fileinfo) {
  return [
    fileinfo?.status,
    fileinfo?.percent,
    fileinfo?.verified,
    fileinfo?.unverified,
    fileinfo?.reverify,
    fileinfo?.ok,
    fileinfo?.catch_all,
    fileinfo?.unknown,
    fileinfo?.invalid,
  ].join('|');
}

/**
 * Resolve CSV text from a download response body.
 * Honors the same split as millionverifier-mcp (~350k chars):
 * - delivery=inline → use envelope.csv
 * - delivery=url → fetch envelope.download_url (signed)
 * - raw octet-stream / CSV body → use as-is
 */
export async function resolveDownloadCsv(bodyText, contentType = '', { onProgress, fileId, fetchImpl = fetch } = {}) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json') || bodyText.trimStart().startsWith('{')) {
    let envelope;
    try {
      envelope = JSON.parse(bodyText);
    } catch {
      return { csvText: bodyText, delivery: 'raw' };
    }

    if (envelope?.error) {
      throw new VendorError(
        envelope.error || envelope.message || 'MillionVerifier download error',
        { vendor: 'millionverifier' }
      );
    }

    const delivery = String(envelope.delivery || '').toLowerCase();
    const signedUrl =
      envelope.download_url ||
      envelope.signed_url ||
      envelope.url ||
      envelope.result?.download_url ||
      null;
    const inlineCsv = envelope.csv || envelope.data || envelope.content || null;

    if (delivery === 'url' || (signedUrl && !inlineCsv)) {
      if (!signedUrl) {
        throw new VendorError(
          'MillionVerifier download returned delivery=url but no download_url',
          { vendor: 'millionverifier' }
        );
      }
      if (onProgress) {
        await onProgress(
          `MillionVerifier file_id=${fileId}: following signed download_url (delivery=url, total_chars=${envelope.total_chars ?? 'n/a'})`
        );
      }
      const signedRes = await fetchImpl(signedUrl);
      if (!signedRes.ok) {
        throw new VendorError(
          `MillionVerifier signed URL download HTTP ${signedRes.status}`,
          { status: signedRes.status, transient: signedRes.status >= 500, vendor: 'millionverifier' }
        );
      }
      return { csvText: await signedRes.text(), delivery: 'url' };
    }

    if (delivery === 'inline' || typeof inlineCsv === 'string') {
      if (typeof inlineCsv !== 'string' || !inlineCsv.length) {
        throw new VendorError(
          'MillionVerifier download returned delivery=inline but empty csv',
          { vendor: 'millionverifier' }
        );
      }
      if (onProgress) {
        await onProgress(
          `MillionVerifier file_id=${fileId}: using inline csv (delivery=inline, chars=${inlineCsv.length})`
        );
      }
      return { csvText: inlineCsv, delivery: 'inline' };
    }

    if (bodyText.includes('\n') && /email/i.test(bodyText.slice(0, 200))) {
      return { csvText: bodyText, delivery: 'raw' };
    }
    throw new VendorError(
      `MillionVerifier download returned unrecognized JSON (keys: ${Object.keys(envelope).join(',')})`,
      { vendor: 'millionverifier' }
    );
  }

  return { csvText: bodyText, delivery: 'raw' };
}

/**
 * Download + parse results for an existing MillionVerifier file_id (no re-upload / no re-charge).
 */
export async function downloadResultsByFileId(
  fileId,
  { onProgress, signal, stageTimeoutMs, stallTimeoutMs } = {}
) {
  if (!fileId) throw new Error('fileId is required');

  let delayMs = 5_000;
  const maxDelay = 30_000;
  const overallMs = Number(stageTimeoutMs ?? config.mvStageTimeoutMs);
  const stallMs = Number(stallTimeoutMs ?? config.mvStallTimeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastKey = '';
  let fileinfo = null;

  while (true) {
    throwIfAborted(signal);

    if (Date.now() - startedAt > overallMs) {
      throw new VendorError(
        `MillionVerifier stage timed out after ${Math.round(overallMs / 60000)}m for file_id=${fileId}` +
          ` (last status=${fileinfo?.status || 'n/a'}, percent=${fileinfo?.percent ?? 'n/a'},` +
          ` verified=${fileinfo?.verified ?? 'n/a'}/${fileinfo?.unique_emails ?? 'n/a'},` +
          ` ok=${fileinfo?.ok ?? 0}, catch_all=${fileinfo?.catch_all ?? 0},` +
          ` unknown=${fileinfo?.unknown ?? 0}, invalid=${fileinfo?.invalid ?? 0}, reverify=${fileinfo?.reverify ?? 0})`,
        { transient: true, vendor: 'millionverifier' }
      );
    }

    const infoUrl =
      `${config.millionVerifierBulkUrl}/fileinfo` +
      `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
      `&file_id=${encodeURIComponent(fileId)}`;

    const { value } = await withRetry(async () => {
      throwIfAborted(signal);
      const infoRes = await fetch(infoUrl, signal ? { signal } : undefined);
      const body = await infoRes.json().catch(() => ({}));
      if (!infoRes.ok || (body.error && String(body.error).trim())) {
        throw new VendorError(
          body.error || body.message || `MillionVerifier fileinfo HTTP ${infoRes.status}`,
          { status: infoRes.status, vendor: 'millionverifier' }
        );
      }
      return body;
    });

    fileinfo = value;
    const status = String(fileinfo.status || '').toLowerCase();
    const key = progressKey(fileinfo);
    if (key !== lastKey) {
      lastKey = key;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallMs) {
      throw new VendorError(
        `MillionVerifier stalled for ${Math.round(stallMs / 60000)}m on file_id=${fileId}` +
          ` (status=${status}, percent=${fileinfo.percent ?? 0},` +
          ` verified=${fileinfo.verified ?? 0}, unverified=${fileinfo.unverified ?? 0},` +
          ` reverify=${fileinfo.reverify ?? 0}, result_counts=0:${Number(fileinfo.ok || 0) + Number(fileinfo.catch_all || 0) + Number(fileinfo.unknown || 0) + Number(fileinfo.invalid || 0)})`,
        { transient: true, vendor: 'millionverifier' }
      );
    }

    if (isMvFileFinished(fileinfo)) break;

    if (['error', 'failed', 'canceled', 'cancelled'].includes(status)) {
      throw new VendorError(fileinfo.error || `MillionVerifier job failed: ${status}`, {
        vendor: 'millionverifier',
      });
    }

    if (onProgress) {
      await onProgress(
        `MillionVerifier file_id=${fileId} status=${status} percent=${fileinfo.percent ?? 0}` +
          ` verified=${fileinfo.verified ?? 0} unverified=${fileinfo.unverified ?? 0}` +
          ` reverify=${fileinfo.reverify ?? 0}` +
          ` (ok=${fileinfo.ok ?? 0}, catch_all=${fileinfo.catch_all ?? 0}, unknown=${fileinfo.unknown ?? 0}, invalid=${fileinfo.invalid ?? 0})`
      );
    }

    await sleep(delayMs, signal);
    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  if (!isMvFileFinished(fileinfo)) {
    throw new VendorError(
      `MillionVerifier polling ended before finished for file_id=${fileId}`,
      { vendor: 'millionverifier' }
    );
  }

  const downloadUrl =
    `${config.millionVerifierBulkUrl}/download` +
    `?key=${encodeURIComponent(config.millionVerifierApiKey)}` +
    `&file_id=${encodeURIComponent(fileId)}` +
    `&filter=all`;

  const { value: csvText } = await withRetry(async () => {
    throwIfAborted(signal);
    const dlRes = await fetch(downloadUrl, signal ? { signal } : undefined);
    if (!dlRes.ok) {
      const errText = await dlRes.text().catch(() => '');
      throw new VendorError(
        `MillionVerifier download HTTP ${dlRes.status}: ${errText.slice(0, 200)}`,
        { status: dlRes.status, vendor: 'millionverifier' }
      );
    }
    const contentType = String(dlRes.headers.get('content-type') || '');
    const bodyText = await dlRes.text();
    const resolved = await resolveDownloadCsv(bodyText, contentType, {
      onProgress,
      fileId,
    });
    return resolved.csvText;
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
export async function verifyBulk(
  emails,
  { onProgress, onFileId, filename = 'verifyfall.csv', signal } = {}
) {
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
      throwIfAborted(signal);
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
        ...(signal ? { signal } : {}),
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

  if (onFileId) {
    await onFileId(String(fileId));
  }

  if (onProgress) {
    await onProgress(`MillionVerifier uploaded file_id=${fileId} (${unique.length} unique emails)`);
  }

  return downloadResultsByFileId(fileId, { onProgress, signal });
}
