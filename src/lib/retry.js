function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientError(err) {
  if (!err) return false;
  if (err.transient === true) return true;
  const status = Number(err.status || err.statusCode || 0);
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('internal server error')
  );
}

/**
 * Retry an async fn with exponential backoff on transient errors.
 * Returns { value, attempts }.
 */
export async function withRetry(
  fn,
  {
    maxAttempts = 5,
    baseDelayMs = 2_000,
    maxDelayMs = 60_000,
    onRetry,
    shouldRetry = isTransientError,
  } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      const delay = Math.min(maxDelayMs, Math.round(baseDelayMs * 2 ** (attempt - 1)));
      if (onRetry) {
        await onRetry({ attempt, maxAttempts, delay, error: err });
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

export class VendorError extends Error {
  constructor(message, { status = 0, transient = false, vendor = 'unknown' } = {}) {
    super(message);
    this.name = 'VendorError';
    this.status = status;
    this.transient = transient || (status >= 500 && status < 600) || status === 429;
    this.vendor = vendor;
  }
}
