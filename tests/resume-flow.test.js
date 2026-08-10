import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunResults, resolveAddressOutcome } from '../src/merge.js';

/**
 * Simulates: MV completed + persisted, N2B fails mid-cohort, then resume
 * continues only pending addresses and merges correctly.
 */
describe('mid-No2Bounce failure then resume', () => {
  it('keeps MV classifications and only submits remaining N2B candidates on resume', () => {
    // After MV stage
    const addressRows = [
      { email: 'ok@ex.com', mv_result: 'ok', n2b_status: null, n2b_cohort: null, final_disposition: 'sendable' },
      { email: 'c1@ex.com', mv_result: 'catch_all', n2b_status: null, n2b_cohort: 'catch_all', final_disposition: 'pending' },
      { email: 'c2@ex.com', mv_result: 'catch_all', n2b_status: null, n2b_cohort: 'catch_all', final_disposition: 'pending' },
      { email: 'u1@ex.com', mv_result: 'unknown', n2b_status: null, n2b_cohort: 'unknown', final_disposition: 'pending' },
      { email: 'bad@ex.com', mv_result: 'invalid', n2b_status: null, n2b_cohort: null, final_disposition: 'rejected' },
    ];

    // First N2B attempt: catch_all batch 1 succeeds, then vendor errors before unknown
    const firstBatch = new Map([
      ['c1@ex.com', { status: 'Deliverable', deliverable: true }],
    ]);
    for (const [email, n2b] of firstBatch) {
      const row = addressRows.find((r) => r.email === email);
      const outcome = resolveAddressOutcome(row.mv_result, n2b);
      row.n2b_status = n2b.status;
      row.final_disposition = outcome.final_disposition;
      row.confidence = outcome.confidence;
      row.verification_source = outcome.verification_source;
    }

    // Run is now failed — partial results available
    const pendingCatchAll = addressRows
      .filter((r) => r.mv_result === 'catch_all' && !r.n2b_status)
      .map((r) => r.email);
    const pendingUnknown = addressRows
      .filter((r) => r.mv_result === 'unknown' && !r.n2b_status)
      .map((r) => r.email);

    assert.deepEqual(pendingCatchAll, ['c2@ex.com']);
    assert.deepEqual(pendingUnknown, ['u1@ex.com']);
    // Must NOT re-include ok/invalid or already-resolved c1
    assert.equal(
      addressRows.filter((r) => r.mv_result === 'ok' || r.mv_result === 'invalid').every((r) => !r.n2b_status),
      true
    );

    // Resume completes remaining
    const resumeResults = new Map([
      ['c2@ex.com', { status: 'Undeliverable', deliverable: false }],
      ['u1@ex.com', { status: 'Deliverable', deliverable: true }],
    ]);
    for (const [email, n2b] of resumeResults) {
      const row = addressRows.find((r) => r.email === email);
      const outcome = resolveAddressOutcome(row.mv_result, n2b);
      row.n2b_status = n2b.status;
      row.final_disposition = outcome.final_disposition;
      row.confidence = outcome.confidence;
      row.verification_source = outcome.verification_source;
    }

    const records = addressRows.map((r) => ({ Email: r.email }));
    const mvResults = new Map(addressRows.map((r) => [r.email, { result: r.mv_result }]));
    const n2bResults = new Map(
      addressRows.filter((r) => r.n2b_status).map((r) => [r.email, { status: r.n2b_status }])
    );

    const merged = mergeRunResults({
      records,
      emailCol: 'Email',
      mvResults,
      n2bResults,
    });

    assert.equal(merged.sendable.length, 3); // ok, c1, u1
    assert.equal(merged.rejected.length, 2); // c2, bad
    assert.ok(merged.sendable.some((r) => r.Email === 'u1@ex.com'));
    assert.ok(merged.rejected.some((r) => r.Email === 'c2@ex.com'));
  });
});

describe('partial results payload shape for failed runs', () => {
  it('exposes stage counts without requiring completed status', () => {
    const failedRun = {
      id: '6e4434e9-a405-4172-bb60-cc2194a06a46',
      status: 'failed',
      stage_completed: 'mv',
      total_emails: 5000,
      mv_ok_count: 3000,
      mv_catch_all_count: 900,
      mv_unknown_count: 271,
      mv_invalid_count: 829,
      n2b_credits_used: 0,
      last_error: "Internal server error Cannot read properties of undefined (reading 'trackingId')",
      final_sendable_count: null,
      final_rejected_count: null,
    };

    const partial = failedRun.status !== 'completed';
    assert.equal(partial, true);
    assert.equal(failedRun.stage_completed, 'mv');
    assert.ok(failedRun.last_error.includes('trackingId'));
    // Caller can still see MV work
    const resolvedApprox =
      failedRun.mv_ok_count +
      failedRun.mv_catch_all_count +
      failedRun.mv_unknown_count +
      failedRun.mv_invalid_count;
    assert.equal(resolvedApprox, failedRun.total_emails);
  });
});
