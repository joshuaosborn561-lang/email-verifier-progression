import { parse } from 'csv-parse/sync';
import { config } from '../config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeN2bStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** Strict Deliverable (not AcceptAll). */
export function isStrictDeliverable(value) {
  const status = normalizeN2bStatus(value);
  return status === 'deliverable' || status === 'valid' || status === 'ok' || status === 'safe' || status === 'good';
}

/** Deliverable/AcceptAll — sendable but lower confidence. */
export function isAcceptAllDeliverable(value) {
  const status = normalizeN2bStatus(value);
  return status === 'deliverable/acceptall' || status === 'deliverableacceptall';
}

function isDeliverableStatus(value) {
  return isStrictDeliverable(value) || isAcceptAllDeliverable(value);
}

/**
 * Submit emails to no2bounce bulk validation and poll until complete.
 * Returns { results: Map<email,{deliverable,status}>, creditsUsed: number }
 *
 * Response shape (confirmed):
 * {
 *   trackingId, overallStatus: "Completed", percent: 100,
 *   result: { downloadFile: "https://..." },
 *   creditDebited, Deliverable, Undeliverable, ...
 * }
 */
export async function validateBulk(emails, { onProgress } = {}) {
  if (!emails.length) return { results: new Map(), creditsUsed: 0 };

  const submitRes = await fetch(`${config.no2bounceBaseUrl}/n2b_validate_bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apitoken: config.no2bounceApiToken,
    },
    body: JSON.stringify({ emailList: emails }),
  });

  const submitBody = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok) {
    throw new Error(
      submitBody?.message || submitBody?.error || `no2bounce submit HTTP ${submitRes.status}`
    );
  }

  const trackingId =
    submitBody.trackingId ||
    submitBody.tracking_id ||
    submitBody.data?.trackingId ||
    submitBody.id;

  if (!trackingId) {
    throw new Error('no2bounce did not return a trackingId');
  }

  if (onProgress) {
    await onProgress(`no2bounce job submitted (trackingId=${trackingId})`);
  }

  let delayMs = 5_000;
  const maxDelay = 30_000;
  const deadline = Date.now() + 60 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(delayMs);

    const pollUrl = `${config.no2bounceBaseUrl}/n2b_validate_bulk?trackingId=${encodeURIComponent(trackingId)}`;
    const pollRes = await fetch(pollUrl, {
      method: 'GET',
      headers: { apitoken: config.no2bounceApiToken },
    });
    const pollBody = await pollRes.json().catch(() => ({}));

    if (!pollRes.ok) {
      throw new Error(
        pollBody?.message || pollBody?.error || `no2bounce poll HTTP ${pollRes.status}`
      );
    }

    const overallStatus = String(
      pollBody.overallStatus || pollBody.status || pollBody.data?.status || ''
    ).toLowerCase();
    const percent = Number(pollBody.percent ?? pollBody.progress ?? 0);

    const downloadFile =
      pollBody.result?.downloadFile ||
      pollBody.downloadFile ||
      pollBody.data?.downloadFile ||
      null;

    const done =
      ['completed', 'complete', 'done', 'finished', 'success'].includes(overallStatus) ||
      (percent >= 100 && downloadFile);

    if (done) {
      const creditsUsed = Number(pollBody.creditDebited ?? pollBody.totalCredit ?? emails.length) || emails.length;
      if (downloadFile) {
        const map = await downloadAndParseResults(downloadFile, emails);
        if (onProgress) {
          const deliverable = [...map.values()].filter((r) => r.deliverable).length;
          await onProgress(
            `no2bounce completed (creditDebited=${creditsUsed}, deliverable=${deliverable}/${emails.length})`
          );
        }
        return { results: map, creditsUsed };
      }

      // Fallback: inline results if ever present
      const results =
        pollBody.results ||
        pollBody.data?.results ||
        pollBody.emailResults ||
        null;
      if (Array.isArray(results)) {
        return { results: normalizeInlineResults(results, emails), creditsUsed };
      }

      throw new Error('no2bounce completed but no downloadFile/results were returned');
    }

    if (['failed', 'error', 'cancelled'].includes(overallStatus)) {
      throw new Error(pollBody.message || `no2bounce job failed: ${overallStatus}`);
    }

    if (onProgress) {
      await onProgress(
        `no2bounce still processing (overallStatus=${overallStatus || 'pending'}, percent=${percent}), next poll in ${Math.round(delayMs / 1000)}s`
      );
    }

    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  throw new Error('no2bounce polling timed out');
}

async function downloadAndParseResults(url, requestedEmails) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download no2bounce results CSV (HTTP ${res.status})`);
  }
  const text = await res.text();
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  const map = new Map();
  for (const row of rows) {
    const email = String(row.email || row.Email || '').toLowerCase();
    if (!email) continue;
    const status = String(row.finalScoreValue || row.status || row.result || '').trim();
    map.set(email, {
      deliverable: isDeliverableStatus(status),
      acceptAll: isAcceptAllDeliverable(status),
      strictDeliverable: isStrictDeliverable(status),
      status: status || 'unknown',
    });
  }

  for (const email of requestedEmails) {
    const key = email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        deliverable: false,
        acceptAll: false,
        strictDeliverable: false,
        status: 'unknown',
      });
    }
  }

  return map;
}

function normalizeInlineResults(results, requestedEmails) {
  const map = new Map();
  for (const item of results) {
    const email = String(item.email || item.Email || item.address || '').toLowerCase();
    if (!email) continue;
    const rawStatus = String(
      item.finalScoreValue || item.status || item.result || item.validation_status || ''
    ).trim();
    const deliverable = isDeliverableStatus(rawStatus) || item.deliverable === true;
    map.set(email, {
      deliverable,
      acceptAll: isAcceptAllDeliverable(rawStatus),
      strictDeliverable: isStrictDeliverable(rawStatus),
      status: rawStatus || 'unknown',
    });
  }
  for (const email of requestedEmails) {
    const key = email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        deliverable: false,
        acceptAll: false,
        strictDeliverable: false,
        status: 'unknown',
      });
    }
  }
  return map;
}
