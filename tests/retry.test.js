import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientError, withRetry, VendorError } from '../src/lib/retry.js';

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
