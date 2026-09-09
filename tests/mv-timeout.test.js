import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadResultsByFileId, isMvFileFinished } from '../src/providers/millionverifier.js';

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

describe('downloadResultsByFileId stall recovery', () => {
  it('pulls the result file at >=90% even when fileinfo tallies are still 0:0', async () => {
    process.env.MILLIONVERIFIER_API_KEY ||= 'test-key';
    const originalFetch = globalThis.fetch;
    let downloadCalls = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/fileinfo')) {
        return {
          ok: true,
          json: async () => ({
            status: 'in_progress',
            percent: 94,
            verified: 3,
            unverified: 1,
            reverify: 0,
            unique_emails: 4,
            ok: 0,
            catch_all: 0,
            unknown: 0,
            invalid: 0,
          }),
        };
      }
      if (u.includes('/download')) {
        downloadCalls += 1;
        return {
          ok: true,
          headers: { get: () => 'text/csv' },
          text: async () => 'Email,result\na@ex.com,ok\nb@ex.com,ok\nc@ex.com,catch_all\n',
        };
      }
      throw new Error(`unexpected fetch ${u}`);
    };

    try {
      const out = await downloadResultsByFileId('32024458', {
        stallTimeoutMs: 60_000,
        stageTimeoutMs: 60_000,
        recoverPercent: 90,
        pollDelayMs: 1,
        emails: ['a@ex.com', 'b@ex.com', 'c@ex.com', 'd@ex.com'],
      });
      assert.equal(downloadCalls, 1);
      assert.equal(out.partial, true);
      assert.equal(out.recovered, 3);
      assert.equal(out.forwardedUnverified, 1);
      assert.equal(out.results.get('a@ex.com').result, 'ok');
      assert.equal(out.results.get('d@ex.com').result, 'unknown');
      assert.equal(out.results.get('d@ex.com').unverified, true);
      assert.equal(out.fileId, '32024458');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
