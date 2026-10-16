import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from '../src/lib/mutex.js';
import {
  chunkEmails,
  parallelBatchLimit,
  runPool,
  validateBulk,
  validateCohorts,
} from '../src/providers/no2bounce.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verdictFor(email, index) {
  const even = index % 2 === 0;
  return {
    deliverable: even,
    acceptAll: false,
    strictDeliverable: even,
    status: even ? 'Deliverable' : 'Undeliverable',
    noVerdict: false,
  };
}

function mapEntries(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function makeVendor({ pollDelayMs = () => 0, onPoll } = {}) {
  return {
    async submitBatch(emails) {
      return { trackingId: `t:${emails[0]}:${emails.length}` };
    },
    async pollUntilDone(trackingId, emails) {
      if (onPoll) await onPoll(trackingId, emails);
      const wait = Number(pollDelayMs(trackingId, emails)) || 0;
      if (wait) await sleep(wait);
      return {
        results: new Map(emails.map((email, index) => [email, verdictFor(email, index)])),
        creditsUsed: emails.length,
        trackingId,
      };
    },
  };
}

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

describe('parallelBatchLimit', () => {
  it('defaults to 3 and caps at 6', () => {
    assert.equal(parallelBatchLimit(), 3);
    assert.equal(parallelBatchLimit(undefined), 3);
    assert.equal(parallelBatchLimit(99), 6);
    assert.equal(parallelBatchLimit(1), 1);
    assert.equal(parallelBatchLimit(0), 1);
  });
});

describe('validateBulk concurrency', () => {
  it('returns the same results and credits for parallel and sequential runs', async () => {
    const emails = Array.from({ length: 10 }, (_, i) => `u${i}@ex.com`);
    const sequential = await validateBulk(emails, {
      batchSize: 2,
      parallelBatches: 1,
      ...makeVendor(),
    });
    const parallel = await validateBulk(emails, {
      batchSize: 2,
      parallelBatches: 3,
      ...makeVendor(),
    });

    assert.deepEqual(mapEntries(parallel.results), mapEntries(sequential.results));
    assert.equal(parallel.creditsUsed, sequential.creditsUsed);
    assert.equal(parallel.batches, sequential.batches);
    assert.equal(parallel.trackingIds.length, 5);
    assert.equal(sequential.trackingIds.length, 5);
  });

  it('keeps onBatchComplete order-safe and matches sequential saves', async () => {
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@ex.com`);

    async function collect(parallelBatches) {
      const saved = new Map();
      const order = [];
      const lock = createMutex();
      const vendor = makeVendor({
        pollDelayMs: (_id, chunk) => (chunk[0] === 'u0@ex.com' ? 25 : 2),
      });
      const out = await validateBulk(emails, {
        batchSize: 2,
        parallelBatches,
        ...vendor,
        onBatchComplete: async ({ batchIndex, batchResults, creditsUsed }) => {
          await lock(async () => {
            order.push(batchIndex);
            for (const [email, value] of batchResults) saved.set(email, value);
            saved._credits = (saved._credits || 0) + creditsUsed;
          });
        },
      });
      return { out, saved, order };
    }

    const sequential = await collect(1);
    const parallel = await collect(3);

    assert.deepEqual(mapEntries(parallel.out.results), mapEntries(sequential.out.results));
    assert.deepEqual(mapEntries(parallel.saved), mapEntries(sequential.saved));
    assert.equal(parallel.saved._credits, sequential.saved._credits);
    assert.equal(parallel.order.length, 4);
  });

  it('resumes only unsaved emails after a kill mid-batch', async () => {
    const emails = Array.from({ length: 6 }, (_, i) => `u${i}@ex.com`);
    const persisted = new Map();
    let inflight = 0;
    let maxInflight = 0;
    let killed = false;

    const hooks = {
      async submitBatch(chunk) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        const trackingId = `t:${chunk[0]}`;
        return { trackingId };
      },
      async pollUntilDone(trackingId, chunk) {
        try {
          if (chunk.includes('u2@ex.com')) {
            await sleep(5);
            killed = true;
            throw new Error('killed mid-batch');
          }
          await sleep(15);
          return {
            results: new Map(chunk.map((email, index) => [email, verdictFor(email, index)])),
            creditsUsed: chunk.length,
            trackingId,
          };
        } finally {
          inflight -= 1;
        }
      },
    };

    await assert.rejects(
      () =>
        validateBulk(emails, {
          batchSize: 2,
          parallelBatches: 3,
          ...hooks,
          onBatchComplete: async ({ batchResults }) => {
            for (const [email, value] of batchResults) persisted.set(email, value);
          },
        }),
      /killed mid-batch/
    );

    assert.equal(killed, true);
    assert.ok(maxInflight >= 2, 'expected overlapping batch workers');
    assert.deepEqual(
      [...persisted.keys()].sort(),
      ['u0@ex.com', 'u1@ex.com', 'u4@ex.com', 'u5@ex.com']
    );
    assert.equal(persisted.has('u2@ex.com'), false);
    assert.equal(persisted.has('u3@ex.com'), false);

    const pending = emails.filter((email) => !persisted.has(email));
    assert.deepEqual(pending, ['u2@ex.com', 'u3@ex.com']);

    const resumed = await validateBulk(pending, {
      batchSize: 2,
      parallelBatches: 3,
      ...makeVendor(),
      onBatchComplete: async ({ batchResults }) => {
        for (const [email, value] of batchResults) persisted.set(email, value);
      },
    });

    assert.deepEqual([...persisted.keys()].sort(), [...emails].sort());
    assert.equal(resumed.creditsUsed, 2);
    assert.equal(persisted.size, emails.length);
  });

  it('does not mark a batch done when onBatchComplete throws before save', async () => {
    const emails = ['a@ex.com', 'b@ex.com', 'c@ex.com', 'd@ex.com'];
    const persisted = new Map();

    await assert.rejects(
      () =>
        validateBulk(emails, {
          batchSize: 2,
          parallelBatches: 2,
          ...makeVendor(),
          onBatchComplete: async ({ chunk, batchResults }) => {
            if (chunk.includes('c@ex.com')) {
              throw new Error('save failed');
            }
            for (const [email, value] of batchResults) persisted.set(email, value);
          },
        }),
      /save failed/
    );

    assert.deepEqual([...persisted.keys()].sort(), ['a@ex.com', 'b@ex.com']);
    const pending = emails.filter((email) => !persisted.has(email));
    assert.deepEqual(pending, ['c@ex.com', 'd@ex.com']);
  });
});

describe('validateCohorts', () => {
  it('runs catch_all and unknown groups at the same time', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const seenCohorts = new Set();

    const result = await validateCohorts({
      catchAllEmails: ['c0@ex.com', 'c1@ex.com'],
      unknownEmails: ['u0@ex.com', 'u1@ex.com'],
      batchSize: 2,
      parallelBatches: 1,
      async submitBatch(emails) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep(15);
        inflight -= 1;
        return { trackingId: `t:${emails[0]}` };
      },
      async pollUntilDone(trackingId, emails) {
        return {
          results: new Map(emails.map((email, index) => [email, verdictFor(email, index)])),
          creditsUsed: emails.length,
          trackingId,
        };
      },
      onBatchComplete: async ({ cohort }) => {
        seenCohorts.add(cohort);
      },
    });

    assert.ok(maxInflight >= 2, 'expected catch_all and unknown to overlap');
    assert.equal(result.creditsUsed, 4);
    assert.equal(result.results.size, 4);
    assert.deepEqual([...seenCohorts].sort(), ['catch_all', 'unknown']);
  });
});

describe('runPool', () => {
  it('finishes in-flight work after one worker fails', async () => {
    const finished = [];
    await assert.rejects(
      () =>
        runPool([0, 1, 2], 3, async (item) => {
          if (item === 1) {
            await sleep(5);
            throw new Error('boom');
          }
          await sleep(15);
          finished.push(item);
        }),
      /boom/
    );
    assert.deepEqual(finished.sort(), [0, 2]);
  });
});
