import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countPersistedMvVerdicts,
  hasUsableMvCoverage,
  isCorruptCompletedRun,
  shouldRecoverPartial,
  zeroVerdictsError,
} from '../src/mv-coverage.js';
import { mergeRunResults, resolveAddressOutcome } from '../src/merge.js';

describe('hasUsableMvCoverage', () => {
  it('rejects MX-only rows with zero MV tallies (the silent-reject bug)', () => {
    const addressRows = [
      { email: 'a@ex.com', mv_result: null },
      { email: 'b@ex.com', mv_result: null },
    ];
    const run = {
      total_emails: 2,
      mv_ok_count: 0,
      mv_catch_all_count: 0,
      mv_unknown_count: 0,
      mv_invalid_count: 0,
    };
    assert.equal(hasUsableMvCoverage({ addressRows, run, expectedCount: 2 }), false);
    assert.equal(countPersistedMvVerdicts(addressRows).assessed, 0);
  });

  it('accepts persisted rows that actually have MV verdicts', () => {
    const addressRows = [
      { email: 'a@ex.com', mv_result: 'ok' },
      { email: 'b@ex.com', mv_result: 'invalid' },
    ];
    const run = {
      mv_ok_count: 1,
      mv_catch_all_count: 0,
      mv_unknown_count: 0,
      mv_invalid_count: 1,
    };
    assert.equal(hasUsableMvCoverage({ addressRows, run, expectedCount: 2 }), true);
  });
});

describe('isCorruptCompletedRun', () => {
  it('flags a completed run with emails but zero MV verdicts', () => {
    assert.equal(
      isCorruptCompletedRun({
        status: 'completed',
        total_emails: 267,
        mv_ok_count: 0,
        mv_catch_all_count: 0,
        mv_unknown_count: 0,
        mv_invalid_count: 0,
      }),
      true
    );
  });
});

describe('shouldRecoverPartial', () => {
  it('recovers a stalled job at >=90% with verified rows', () => {
    assert.equal(
      shouldRecoverPartial(
        { percent: 94, verified: 251, unverified: 16 },
        { stalled: true, recoverPercent: 90 }
      ),
      true
    );
  });

  it('does not recover a mid-job stall below the threshold', () => {
    assert.equal(
      shouldRecoverPartial(
        { percent: 40, verified: 10, unverified: 15 },
        { stalled: true, recoverPercent: 90 }
      ),
      false
    );
  });
});

describe('zero-verdict merge guard', () => {
  it('explains that unverified rows must not be rejected', () => {
    const msg = zeroVerdictsError({ totalEmails: 267, fileId: '32024458' });
    assert.match(msg, /no verdicts for 267/);
    assert.match(msg, /32024458/);
    assert.match(msg, /Refusing to mark unverified rows as rejected/);
  });
});

describe('never-verified rows stay unresolved', () => {
  it('does not put never-assessed contacts in rejected', () => {
    const records = [
      { Email: 'ok@ex.com' },
      { Email: 'ghost@ex.com' },
    ];
    const merged = mergeRunResults({
      records,
      emailCol: 'Email',
      mvResults: new Map([['ok@ex.com', { result: 'ok' }]]),
      n2bResults: new Map(),
    });
    assert.equal(merged.sendable.length, 1);
    assert.equal(merged.rejected.length, 0);
    assert.equal(merged.unresolved.length, 1);
    assert.equal(merged.neverVerified, 1);
    assert.equal(merged.unresolved[0].Email, 'ghost@ex.com');
    assert.equal(merged.unresolved[0].verification_status, 'never_verified');
  });

  it('marks an unassessed address unresolved, not rejected', () => {
    const out = resolveAddressOutcome(null, null, { assessed: false });
    assert.equal(out.final_disposition, 'unresolved');
    assert.equal(out.verification_status, 'never_verified');
  });
});
