import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMvFileFinished } from '../src/providers/millionverifier.js';

describe('isMvFileFinished', () => {
  it('accepts status=finished', () => {
    assert.equal(isMvFileFinished({ status: 'finished', percent: 100 }), true);
  });

  it('accepts percent=100 with tallies and no reverify even if status lags', () => {
    assert.equal(
      isMvFileFinished({
        status: 'in_progress',
        percent: 100,
        reverify: 0,
        ok: 10,
        catch_all: 2,
        unknown: 0,
        invalid: 1,
      }),
      true
    );
  });

  it('does not treat stuck mid-progress with zero tallies as finished', () => {
    assert.equal(
      isMvFileFinished({
        status: 'in_progress',
        percent: 50,
        reverify: 0,
        verified: 1,
        unverified: 1,
        ok: 0,
        catch_all: 0,
        unknown: 0,
        invalid: 0,
      }),
      false
    );
  });
});
