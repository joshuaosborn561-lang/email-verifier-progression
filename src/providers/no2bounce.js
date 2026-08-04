import { config } from '../config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit emails to no2bounce bulk validation and poll until complete.
 * Returns Map<email, { deliverable: boolean, status: string }>
 */
export async function validateBulk(emails, { onProgress } = {}) {
  if (!emails.length) return new Map();

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
  const deadline = Date.now() + 60 * 60 * 1000; // 1 hour safety

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

    const status = String(
      pollBody.status || pollBody.data?.status || pollBody.jobStatus || ''
    ).toLowerCase();

    const results =
      pollBody.results ||
      pollBody.data?.results ||
      pollBody.emailResults ||
      pollBody.data?.emailList ||
      null;

    const done =
      ['completed', 'complete', 'done', 'finished', 'success'].includes(status) ||
      (Array.isArray(results) && results.length > 0 && !['pending', 'processing', 'queued', 'in_progress', 'running'].includes(status));

    if (done && Array.isArray(results)) {
      return normalizeResults(results, emails);
    }

    if (['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(pollBody.message || `no2bounce job failed: ${status}`);
    }

    if (onProgress) {
      await onProgress(`no2bounce still processing (status=${status || 'unknown'}), next poll in ${delayMs / 1000}s`);
    }

    delayMs = Math.min(maxDelay, Math.round(delayMs * 1.4));
  }

  throw new Error('no2bounce polling timed out');
}

function normalizeResults(results, requestedEmails) {
  const map = new Map();

  for (const item of results) {
    const email = String(item.email || item.Email || item.address || '').toLowerCase();
    if (!email) continue;

    const rawStatus = String(
      item.status || item.result || item.validation_status || item.deliverability || ''
    ).toLowerCase();

    const deliverable =
      item.deliverable === true ||
      item.isDeliverable === true ||
      ['deliverable', 'valid', 'ok', 'safe', 'good'].includes(rawStatus);

    map.set(email, {
      deliverable,
      status: rawStatus || (deliverable ? 'deliverable' : 'undeliverable'),
    });
  }

  for (const email of requestedEmails) {
    const key = email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { deliverable: false, status: 'unknown' });
    }
  }

  return map;
}
