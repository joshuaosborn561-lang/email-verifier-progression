import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateOrServerError,
  isTransientError,
  retryDelayMs,
  withRetry,
  VendorError,
} from '../src/lib/retry.js';

describe('isTransientError', () => {
  it('detects 5xx VendorError', () => {
    assert.equal(isTransientError(new VendorError('boom', { status: 500 })), true);
  });

  it('detects timeout messages', () => {
    assert.equal(isTransientError(new Error('polling timed out')), true);
  });

  it('does not retry plain validation errors', () => {
    assert.equal(isTransientError(new Error('invalid api key')), false);
  });
});

describe('withRetry', () => {
  it('retries transient failures then succeeds', async () => {
    let attempts = 0;
    const { value, attempts: used } = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new VendorError('Internal server error', { status: 500, vendor: 'no2bounce' });
        }
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }
    );
    assert.equal(value, 'ok');
    assert.equal(used, 3);
  });

  it('backs off with jitter on 429 and 5xx', async () => {
    assert.equal(isRateOrServerError(new VendorError('slow', { status: 429 })), true);
    assert.equal(isRateOrServerError(new VendorError('boom', { status: 503 })), true);
    assert.equal(isRateOrServerError(new VendorError('nope', { status: 400 })), false);

    const low = retryDelayMs(1, { baseDelayMs: 1_000, jitter: true, random: () => 0 });
    const high = retryDelayMs(1, { baseDelayMs: 1_000, jitter: true, random: () => 1 });
    const exact = retryDelayMs(1, { baseDelayMs: 1_000, jitter: false });
    assert.equal(exact, 1_000);
    assert.equal(low, 500);
    assert.equal(high, 1_000);
    assert.ok(low < high);

    const delays = [];
    let n = 0;
    const { value } = await withRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw new VendorError('rate limited', { status: 429, vendor: 'no2bounce' });
        }
        return 'ok';
      },
      {
        maxAttempts: 5,
        baseDelayMs: 20,
        maxDelayMs: 40,
        onRetry: ({ delay, error }) => {
          delays.push(delay);
          assert.equal(error.status, 429);
        },
      }
    );
    assert.equal(value, 'ok');
    assert.equal(delays.length, 2);
    for (const delay of delays) {
      assert.ok(delay >= 10);
      assert.ok(delay <= 40);
    }
  });

  it('stops on non-transient errors', async () => {
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            throw new VendorError('bad request', { status: 400, vendor: 'no2bounce' });
          },
          { maxAttempts: 5, baseDelayMs: 1 }
        ),
      /bad request/
    );
  });
});
