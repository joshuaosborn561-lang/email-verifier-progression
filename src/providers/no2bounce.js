import { parse } from 'csv-parse/sync';
import { config } from '../config.js';
import { VendorError, withRetry } from '../lib/retry.js';

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

export function chunkEmails(emails, batchSize = config.n2bSubmitBatchSize) {
  const size = Math.max(1, Number(batchSize) || 150);
  const chunks = [];
  for (let i = 0; i < emails.length; i += size) {
    chunks.push(emails.slice(i, i + size));
  }
  return chunks;
}

function extractTrackingId(body) {
  return (
    body?.trackingId ||
    body?.tracking_id ||
    body?.data?.trackingId ||
    body?.data?.tracking_id ||
    body?.id ||
    null
  );
}

async function submitBatch(emails) {
  const { value } = await withRetry(
    async () => {
      let submitRes;
      try {
        submitRes = await fetch(`${config.no2bounceBaseUrl}/n2b_validate_bulk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apitoken: config.no2bounceApiToken,
          },
          body: JSON.stringify({ emailList: emails }),
        });
      } catch (err) {
        throw new VendorError(`no2bounce submit network error: ${err.message}`, {
          transient: true,
          vendor: 'no2bounce',
        });
      }

      const submitBody = await submitRes.json().catch(() => ({}));
      if (!submitRes.ok) {
        const msg =
          submitBody?.message ||
          submitBody?.error ||
          `no2bounce submit HTTP ${submitRes.status}`;
        throw new VendorError(msg, {
          status: submitRes.status,
          transient: submitRes.status >= 500 || submitRes.status === 429,
          vendor: 'no2bounce',
        });
      }

      const trackingId = extractTrackingId(submitBody);
      if (!trackingId) {
        // Vendor sometimes returns 200 with an error payload and no trackingId
        const msg =
          submitBody?.message ||
          submitBody?.error ||
          `no2bounce did not return a trackingId (body keys: ${Object.keys(submitBody || {}).join(',')})`;
        throw new VendorError(msg, {
          status: 500,
          transient: /internal server error|timeout|temporar/i.test(String(msg)),
          vendor: 'no2bounce',
        });
      }

      return { trackingId, submitBody };
    },
    { maxAttempts: config.vendorMaxAttempts, baseDelayMs: config.vendorRetryBaseMs }
  );
  return value;
}

async function pollUntilDone(trackingId, emails, { onProgress } = {}) {
  let delayMs = 5_000;
  const maxDelay = 30_000;
  const deadline = Date.now() + 60 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(delayMs);

    const pollUrl = `${config.no2bounceBaseUrl}/n2b_validate_bulk?trackingId=${encodeURIComponent(trackingId)}`;
    const { value: pollBody } = await withRetry(
      async () => {
        let pollRes;
        try {
          pollRes = await fetch(pollUrl, {
            method: 'GET',
            headers: { apitoken: config.no2bounceApiToken },
          });
        } catch (err) {
          throw new VendorError(`no2bounce poll network error: ${err.message}`, {
            transient: true,
            vendor: 'no2bounce',
          });
        }
        const body = await pollRes.json().catch(() => ({}));
        if (!pollRes.ok) {
          throw new VendorError(
            body?.message || body?.error || `no2bounce poll HTTP ${pollRes.status}`,
            {
              status: pollRes.status,
              transient: pollRes.status >= 500 || pollRes.status === 429,
              vendor: 'no2bounce',
            }
          );
        }
        return body;
      },
      { maxAttempts: 3, baseDelayMs: 2_000 }
    );

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
      const creditsUsed =
        Number(pollBody.creditDebited ?? pollBody.totalCredit ?? emails.length) || emails.length;
      if (downloadFile) {
        const map = await downloadAndParseResults(downloadFile, emails);
        return { results: map, creditsUsed, trackingId };
      }

      const results =
        pollBody.results ||
        pollBody.data?.results ||
        pollBody.emailResults ||
        null;
      if (Array.isArray(results)) {
        return {
          results: normalizeInlineResults(results, emails),
          creditsUsed,
          trackingId,
        };
      }

      throw new VendorError('no2bounce completed but no downloadFile/results were returned', {
        vendor: 'no2bounce',
      });
    }

    if (['failed', 'error', 'cancelled'].includes(overallStatus)) {
      throw new VendorError(pollBody.message || `no2bounce job failed: ${overallStatus}`, {
        vendor: 'no2bounce',
      });
    }

    if (onProgress) {
      await onProgress(
        `no2bounce still processing trackingId=${trackingId} (overallStatus=${overallStatus || 'pending'}, percent=${percent}), next poll in ${Math.round(delayMs / 1000)}s`
      );
    }

    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  throw new VendorError('no2bounce polling timed out', {
    transient: true,
    vendor: 'no2bounce',
  });
}

/**
 * Validate a list of emails via no2bounce, submitting in small batches.
 * Large single submits (~1000+) return vendor 500:
 * "Internal server error Cannot read properties of undefined (reading 'trackingId')"
 *
 * Returns { results: Map, creditsUsed, batches, trackingIds }
 */
export async function validateBulk(emails, { onProgress, onBatchComplete, batchSize, cohort } = {}) {
  if (!emails.length) {
    return { results: new Map(), creditsUsed: 0, batches: 0, trackingIds: [] };
  }

  const chunks = chunkEmails(emails, batchSize ?? config.n2bSubmitBatchSize);
  const results = new Map();
  let creditsUsed = 0;
  const trackingIds = [];
  const label = cohort ? ` cohort=${cohort}` : '';

  if (onProgress) {
    await onProgress(
      `no2bounce submitting ${emails.length} emails in ${chunks.length} batch(es)${label} (batchSize=${batchSize ?? config.n2bSubmitBatchSize})`
    );
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (onProgress) {
      await onProgress(
        `no2bounce batch ${i + 1}/${chunks.length}${label}: submitting ${chunk.length} emails`
      );
    }

    const { trackingId } = await submitBatch(chunk);
    trackingIds.push(trackingId);

    if (onProgress) {
      await onProgress(
        `no2bounce batch ${i + 1}/${chunks.length}${label}: trackingId=${trackingId}`
      );
    }

    const batchResult = await pollUntilDone(trackingId, chunk, { onProgress });
    creditsUsed += batchResult.creditsUsed;
    for (const [email, value] of batchResult.results) {
      results.set(email, value);
    }

    if (onBatchComplete) {
      await onBatchComplete({
        cohort,
        batchIndex: i,
        batchCount: chunks.length,
        chunk,
        batchResults: batchResult.results,
        creditsUsed: batchResult.creditsUsed,
        trackingId,
      });
    }

    if (onProgress) {
      const deliverable = [...batchResult.results.values()].filter((r) => r.deliverable).length;
      await onProgress(
        `no2bounce batch ${i + 1}/${chunks.length}${label} complete: deliverable=${deliverable}/${chunk.length}, credits+=${batchResult.creditsUsed}`
      );
    }
  }

  return {
    results,
    creditsUsed,
    batches: chunks.length,
    trackingIds,
  };
}

/**
 * Validate catch_all and unknown cohorts separately (never merged before submit).
 */
export async function validateCohorts({
  catchAllEmails,
  unknownEmails,
  onProgress,
  onBatchComplete,
  batchSize,
} = {}) {
  const catchAll = catchAllEmails || [];
  const unknown = unknownEmails || [];

  const catchAllResult = await validateBulk(catchAll, {
    onProgress,
    onBatchComplete,
    batchSize,
    cohort: 'catch_all',
  });
  const unknownResult = await validateBulk(unknown, {
    onProgress,
    onBatchComplete,
    batchSize,
    cohort: 'unknown',
  });

  const results = new Map([
    ...catchAllResult.results,
    ...unknownResult.results,
  ]);

  return {
    results,
    creditsUsed: catchAllResult.creditsUsed + unknownResult.creditsUsed,
    catchAll: catchAllResult,
    unknown: unknownResult,
  };
}

async function downloadAndParseResults(url, requestedEmails) {
  const { value: text } = await withRetry(async () => {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new VendorError(`no2bounce results download network error: ${err.message}`, {
        transient: true,
        vendor: 'no2bounce',
      });
    }
    if (!res.ok) {
      throw new VendorError(`Failed to download no2bounce results CSV (HTTP ${res.status})`, {
        status: res.status,
        vendor: 'no2bounce',
      });
    }
    return res.text();
  });

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
    const noVerdict = !status || normalizeN2bStatus(status) === 'unknown';
    map.set(email, {
      deliverable: isDeliverableStatus(status),
      acceptAll: isAcceptAllDeliverable(status),
      strictDeliverable: isStrictDeliverable(status),
      status: status || 'unknown',
      noVerdict,
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
        noVerdict: true,
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
    const noVerdict = !rawStatus || normalizeN2bStatus(rawStatus) === 'unknown';
    map.set(email, {
      deliverable,
      acceptAll: isAcceptAllDeliverable(rawStatus),
      strictDeliverable: isStrictDeliverable(rawStatus),
      status: rawStatus || 'unknown',
      noVerdict,
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
        noVerdict: true,
      });
    }
  }
  return map;
}
