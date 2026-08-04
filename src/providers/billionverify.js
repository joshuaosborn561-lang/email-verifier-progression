import { config } from '../config.js';

/**
 * Verify a batch of emails via BillionVerify bulk API.
 * Returns Map<email, { status, credits_used, is_catchall }>
 */
export async function verifyBatch(emails) {
  if (!emails.length) return new Map();

  const res = await fetch(`${config.billionVerifyBaseUrl}/verify/bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BV-API-KEY': config.billionVerifyApiKey,
    },
    body: JSON.stringify({
      emails,
      check_smtp: true,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const msg = body?.error?.message || body?.message || `BillionVerify HTTP ${res.status}`;
    throw new Error(msg);
  }

  const results = body?.data?.results || body?.results || [];
  const map = new Map();
  for (const item of results) {
    const email = String(item.email || '').toLowerCase();
    let status = String(item.status || 'unknown').toLowerCase();
    if (item.is_catchall === true && status === 'valid') {
      status = 'catchall';
    }
    map.set(email, {
      status,
      credits_used: Number(item.credits_used ?? 1) || 0,
      is_catchall: Boolean(item.is_catchall),
    });
  }

  // Ensure every requested email has an entry
  for (const email of emails) {
    const key = email.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { status: 'unknown', credits_used: 0, is_catchall: false });
    }
  }

  return map;
}
