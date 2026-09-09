import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __setSupabaseClientForTests } from '../src/db.js';
import { classifyEmailsByMx, lookupDomainMx } from '../src/providers/mx-lookup.js';

function makeCacheClient(store) {
  return {
    from(table) {
      if (table !== 'domain_mx_cache') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return {
            eq(_col, domain) {
              return {
                async maybeSingle() {
                  return { data: store.get(domain) || null, error: null };
                },
              };
            },
          };
        },
        async upsert(row, opts) {
          if (opts?.ignoreDuplicates && store.has(row.domain)) {
            return { error: null };
          }
          store.set(row.domain, { ...store.get(row.domain), ...row });
          return { error: null };
        },
        update(patch) {
          return {
            async eq(_col, domain) {
              const existing = store.get(domain);
              if (existing) store.set(domain, { ...existing, ...patch });
              return { error: null };
            },
          };
        },
      };
    },
  };
}

afterEach(() => {
  __setSupabaseClientForTests(null);
});

describe('lookupDomainMx cache', () => {
  it('resolves MX once per domain and reuses the persisted cache', async () => {
    const store = new Map();
    __setSupabaseClientForTests(makeCacheClient(store));
    let calls = 0;
    const resolveFn = async (domain) => {
      calls += 1;
      assert.equal(domain, 'acme.com');
      return [{ exchange: 'mx1.pphosted.com', priority: 10 }];
    };

    const first = await lookupDomainMx('acme.com', { resolveFn });
    assert.equal(first.cached, false);
    assert.equal(first.mail_class, 'seg');
    assert.equal(first.gateway_provider, 'proofpoint');
    assert.equal(calls, 1);
    assert.equal(store.has('acme.com'), true);

    const second = await lookupDomainMx('acme.com', { resolveFn });
    assert.equal(second.cached, true);
    assert.equal(second.mail_class, 'seg');
    assert.equal(second.mx_host, 'mx1.pphosted.com');
    assert.equal(calls, 1);
  });

  it('looks each unique domain up once across a list of contacts', async () => {
    const store = new Map();
    __setSupabaseClientForTests(makeCacheClient(store));
    const seen = [];
    const resolveFn = async (domain) => {
      seen.push(domain);
      if (domain === 'seg.example') return [{ exchange: 'cluster5.us.iphmx.com', priority: 10 }];
      if (domain === 'google.example') return [{ exchange: 'aspmx.l.google.com', priority: 1 }];
      return [];
    };

    const { byEmail, uniqueDomains, lookedUp } = await classifyEmailsByMx(
      [
        'a@seg.example',
        'b@seg.example',
        'c@google.example',
        'd@google.example',
      ],
      { resolveFn, concurrency: 2 }
    );

    assert.equal(uniqueDomains, 2);
    assert.equal(lookedUp, 2);
    assert.deepEqual(seen.sort(), ['google.example', 'seg.example']);
    assert.equal(byEmail.get('a@seg.example').mail_class, 'seg');
    assert.equal(byEmail.get('b@seg.example').gateway_provider, 'cisco');
    assert.equal(byEmail.get('c@google.example').mail_class, 'native_filter');
    assert.equal(byEmail.get('d@google.example').gateway_provider, 'google');
  });

  it('tags DNS failures as unknown and does not throw', async () => {
    const store = new Map();
    __setSupabaseClientForTests(makeCacheClient(store));
    const resolveFn = async () => {
      const err = new Error('query timed out');
      err.code = 'ETIMEOUT';
      throw err;
    };

    const result = await lookupDomainMx('flaky.example', { resolveFn });
    assert.equal(result.mail_class, 'unknown');
    assert.equal(result.behind_gateway, false);
    assert.match(String(result.lookup_error), /ETIMEOUT/);
  });
});
