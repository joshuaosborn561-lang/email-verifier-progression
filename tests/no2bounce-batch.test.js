import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEmails } from '../src/providers/no2bounce.js';

describe('chunkEmails', () => {
  it('splits large candidate lists into safe submit batches', () => {
    const emails = Array.from({ length: 1155 }, (_, i) => `u${i}@ex.com`);
    const chunks = chunkEmails(emails, 150);
    assert.equal(chunks.length, 8);
    assert.equal(chunks[0].length, 150);
    assert.equal(chunks.at(-1).length, 105);
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), 1155);
  });

  it('keeps catch_all and unknown cohort arrays independent', () => {
    const catchAll = Array.from({ length: 200 }, (_, i) => `c${i}@ex.com`);
    const unknown = Array.from({ length: 50 }, (_, i) => `u${i}@ex.com`);
    const catchChunks = chunkEmails(catchAll, 150);
    const unknownChunks = chunkEmails(unknown, 150);
    assert.equal(catchChunks.length, 2);
    assert.equal(unknownChunks.length, 1);
    assert.ok(catchChunks.flat().every((e) => e.startsWith('c')));
    assert.ok(unknownChunks.flat().every((e) => e.startsWith('u')));
  });
});
