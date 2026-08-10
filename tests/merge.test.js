import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunResults, resolveAddressOutcome } from '../src/merge.js';

describe('resolveAddressOutcome', () => {
  it('MV ok → sendable confirmed', () => {
    const out = resolveAddressOutcome('ok', null);
    assert.equal(out.final_disposition, 'sendable');
    assert.equal(out.confidence, 'confirmed');
    assert.equal(out.verification_source, 'millionverifier');
  });

  it('MV invalid → rejected', () => {
    const out = resolveAddressOutcome('invalid', null);
    assert.equal(out.final_disposition, 'rejected');
  });

  it('unknown resolved by No2Bounce as Deliverable → sendable', () => {
    const out = resolveAddressOutcome('unknown', { status: 'Deliverable' });
    assert.equal(out.final_disposition, 'sendable');
    assert.equal(out.confidence, 'confirmed');
    assert.equal(out.verification_source, 'no2bounce');
    assert.equal(out.unresolved_after_n2b, false);
  });

  it('unknown with no No2Bounce verdict → rejected + unresolved_after_n2b', () => {
    const out = resolveAddressOutcome('unknown', { status: 'unknown', noVerdict: true });
    assert.equal(out.final_disposition, 'rejected');
    assert.equal(out.unresolved_after_n2b, true);
  });

  it('catch_all rejected by No2Bounce → rejected (not unresolved)', () => {
    const out = resolveAddressOutcome('catch_all', { status: 'Undeliverable' });
    assert.equal(out.final_disposition, 'rejected');
    assert.equal(out.unresolved_after_n2b, false);
  });

  it('catch_all AcceptAll → sendable unresolved_catchall', () => {
    const out = resolveAddressOutcome('catch_all', { status: 'Deliverable/AcceptAll' });
    assert.equal(out.final_disposition, 'sendable');
    assert.equal(out.confidence, 'unresolved_catchall');
  });
});

describe('mergeRunResults bucketing', () => {
  it('buckets MV ok + N2B-confirmed unknown as sendable; unresolved unknown as rejected', () => {
    const records = [
      { Email: 'ok@ex.com', name: 'a' },
      { Email: 'unknown-good@ex.com', name: 'b' },
      { Email: 'unknown-bad@ex.com', name: 'c' },
      { Email: 'catch-reject@ex.com', name: 'd' },
      { Email: 'invalid@ex.com', name: 'e' },
    ];
    const mvResults = new Map([
      ['ok@ex.com', { result: 'ok' }],
      ['unknown-good@ex.com', { result: 'unknown' }],
      ['unknown-bad@ex.com', { result: 'unknown' }],
      ['catch-reject@ex.com', { result: 'catch_all' }],
      ['invalid@ex.com', { result: 'invalid' }],
    ]);
    const n2bResults = new Map([
      ['unknown-good@ex.com', { status: 'Deliverable' }],
      ['unknown-bad@ex.com', { status: 'unknown', noVerdict: true }],
      ['catch-reject@ex.com', { status: 'Undeliverable' }],
    ]);

    const merged = mergeRunResults({
      records,
      emailCol: 'Email',
      mvResults,
      n2bResults,
    });

    assert.equal(merged.sendable.length, 2);
    assert.equal(merged.rejected.length, 3);
    assert.equal(merged.unresolvedAfterN2b, 1);
    assert.ok(merged.sendable.some((r) => r.Email === 'ok@ex.com'));
    assert.ok(merged.sendable.some((r) => r.Email === 'unknown-good@ex.com'));
    assert.ok(merged.rejected.some((r) => r.Email === 'catch-reject@ex.com'));
    assert.ok(merged.rejected.some((r) => r.Email === 'unknown-bad@ex.com'));
  });
});
