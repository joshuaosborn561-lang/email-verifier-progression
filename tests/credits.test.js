import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMvCreditsUsed } from '../src/providers/millionverifier.js';

describe('computeMvCreditsUsed', () => {
  it('uses ok + invalid (not catch_all/unknown)', () => {
    const credits = computeMvCreditsUsed(
      { ok: 3000, catch_all: 800, unknown: 200, invalid: 1000, credit: 1 },
      null
    );
    assert.equal(credits, 4000);
  });

  it('prefers fileinfo.credit when it looks like a total', () => {
    const credits = computeMvCreditsUsed(
      { ok: 100, invalid: 50, catch_all: 20, unknown: 10, credit: 150 },
      null
    );
    assert.equal(credits, 150);
  });

  it('ignores concurrent-balance-style nonsense by not using deltas', () => {
    // Guard: even if someone passes a huge unrelated number as credit=1 unit cost
    const credits = computeMvCreditsUsed(
      { ok: 3829, invalid: 0, catch_all: 900, unknown: 271, credit: 1 },
      { ok: 3829, invalid: 0 }
    );
    assert.equal(credits, 3829);
  });
});
