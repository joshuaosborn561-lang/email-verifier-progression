import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMvStallError,
  salvageDecision,
  shouldRefuseUnmovingResume,
  usefulOutputCount,
} from '../src/salvage.js';

const PARLAY_ERROR =
  'MillionVerifier stalled for 12m on file_id=32034648 (status=in_progress, percent=95, verified=10278, unverified=447, reverify=0, result_counts=0)';

describe('parseMvStallError', () => {
  it('reads file_id / percent / verified from the stall string', () => {
    assert.deepEqual(parseMvStallError(PARLAY_ERROR), {
      fileId: '32034648',
      percent: 95,
      verified: 10278,
      unverified: 447,
    });
  });
});

describe('salvageDecision', () => {
  it('marks the Parlay reference case as failed with nothing to salvage', () => {
    const decision = salvageDecision({
      run: {
        status: 'failed',
        total_emails: 11021,
        final_sendable_count: 0,
        retry_count: 2,
        last_error: PARLAY_ERROR,
        mv_ok_count: 0,
        mv_catch_all_count: 0,
        mv_unknown_count: 0,
        mv_invalid_count: 0,
      },
      resolvedCounts: {
        total: 10725,
        pending: 10725,
        sendable: 0,
        rejected: 0,
        mv_ok: 0,
        mv_catch_all: 0,
        mv_unknown: 0,
        mv_invalid: 0,
        awaiting_n2b: 0,
      },
    });
    assert.equal(decision.action, 'fresh_ok');
    assert.equal(decision.useful_output_count, 0);
    assert.equal(decision.do_not_resume, true);
    assert.match(decision.reason, /failed run/i);
  });

  it('resumes when MV finished and N2B did not', () => {
    const decision = salvageDecision({
      run: { mv_ok_count: 13, mv_catch_all_count: 2, retry_count: 1 },
      resolvedCounts: {
        sendable: 0,
        rejected: 0,
        pending: 2,
        mv_ok: 13,
        mv_catch_all: 2,
        awaiting_n2b: 2,
      },
    });
    assert.equal(decision.action, 'resume');
    assert.match(decision.reason, /Resume this run/);
  });

  it('salvages when some verdicts exist and some rows are still pending', () => {
    const decision = salvageDecision({
      run: { final_sendable_count: 40, mv_ok_count: 40 },
      resolvedCounts: {
        sendable: 40,
        rejected: 10,
        pending: 50,
        mv_ok: 40,
        mv_invalid: 10,
        awaiting_n2b: 0,
      },
    });
    assert.equal(decision.action, 'salvage');
    assert.equal(decision.useful_output_count, 40);
    assert.equal(decision.remainder_estimate, 50);
  });
});

describe('shouldRefuseUnmovingResume', () => {
  it('blocks a third resume on an unmoving stall', () => {
    const run = { retry_count: 2, last_error: PARLAY_ERROR };
    assert.equal(shouldRefuseUnmovingResume(run), true);
    assert.equal(shouldRefuseUnmovingResume(run, { force: true }), false);
  });

  it('allows the first resume', () => {
    assert.equal(
      shouldRefuseUnmovingResume({ retry_count: 1, last_error: PARLAY_ERROR }),
      false
    );
  });
});

describe('usefulOutputCount', () => {
  it('is sendable addresses, never rows submitted', () => {
    assert.equal(usefulOutputCount({ final_sendable_count: 0, total_emails: 11021 }, { sendable: 0 }), 0);
    assert.equal(usefulOutputCount({ final_sendable_count: 261 }, { sendable: 261 }), 261);
  });
});
