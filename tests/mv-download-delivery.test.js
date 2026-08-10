import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDownloadCsv } from '../src/providers/millionverifier.js';

describe('resolveDownloadCsv delivery split', () => {
  it('follows signed download_url when delivery=url (large / >350k path)', async () => {
    const fetchImpl = async (url) => {
      assert.match(String(url), /signed\.example/);
      return {
        ok: true,
        text: async () => 'Email,result\na@ex.com,ok\nb@ex.com,ok\n',
      };
    };

    const body = JSON.stringify({
      delivery: 'url',
      total_chars: 400_000,
      download_url: 'https://signed.example/results.csv',
    });

    const { csvText, delivery } = await resolveDownloadCsv(body, 'application/json', {
      fileId: '31666554',
      fetchImpl,
    });

    assert.equal(delivery, 'url');
    assert.match(csvText, /a@ex\.com/);
    assert.equal(csvText.trim().split('\n').length, 3);
  });

  it('uses envelope.csv when delivery=inline (small / <350k path)', async () => {
    const inline = 'Email,result\nx@ex.com,ok\ny@ex.com,catch_all\n';
    assert.ok(inline.length < 350_000);

    const { csvText, delivery } = await resolveDownloadCsv(
      JSON.stringify({ delivery: 'inline', csv: inline, total_chars: inline.length }),
      'application/json',
      { fileId: '1' }
    );

    assert.equal(delivery, 'inline');
    assert.equal(csvText, inline);
  });

  it('passes through raw octet-stream CSV from the bulk API', async () => {
    const raw = 'Email,result\nz@ex.com,ok\n';
    const { csvText, delivery } = await resolveDownloadCsv(raw, 'application/octet-stream');
    assert.equal(delivery, 'raw');
    assert.equal(csvText, raw);
  });

  it('errors if delivery=url omits download_url (would otherwise look truncated)', async () => {
    await assert.rejects(
      () =>
        resolveDownloadCsv(
          JSON.stringify({ delivery: 'url', total_chars: 400_000 }),
          'application/json'
        ),
      /no download_url/
    );
  });
});
