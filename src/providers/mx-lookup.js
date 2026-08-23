import { promises as dns } from 'node:dns';
import { classifyMxHosts, extractDomain, MAIL_CLASS } from '../mx.js';
import {
  getDomainMxCache,
  incrementDomainMxSeen,
  upsertDomainMxCache,
} from '../db.js';

const DEFAULT_CONCURRENCY = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveMxHosts(domain, resolveFn = dns.resolveMx) {
  try {
    const records = await resolveFn(domain);
    if (!Array.isArray(records) || !records.length) {
      return { hosts: [], error: 'no_mx' };
    }
    const sorted = [...records].sort(
      (a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0)
    );
    const hosts = sorted
      .map((r) => String(r.exchange || '').trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean);
    return { hosts, error: null };
  } catch (err) {
    const code = err?.code || err?.errno || '';
    const message = err?.message || String(err);
    return { hosts: [], error: code ? `${code}: ${message}` : message };
  }
}

function cacheRowToResult(row, domain) {
  return {
    domain,
    mx_host: row.mx_host || null,
    mx_hosts: row.mx_hosts || (row.mx_host ? row.mx_host : ''),
    mail_class: row.mail_class || MAIL_CLASS.UNKNOWN,
    gateway_provider: row.gateway_provider || 'none',
    behind_gateway: row.mail_class === MAIL_CLASS.SEG,
    lookup_error: row.lookup_error || null,
    cached: true,
  };
}

export async function lookupDomainMx(domain, { resolveFn } = {}) {
  const key = String(domain || '').trim().toLowerCase();
  if (!key) {
    return {
      domain: null,
      mx_host: null,
      mx_hosts: '',
      mail_class: MAIL_CLASS.UNKNOWN,
      gateway_provider: 'none',
      behind_gateway: false,
      lookup_error: 'missing_domain',
      cached: false,
    };
  }

  try {
    const cached = await getDomainMxCache(key);
    if (cached) {
      try {
        await incrementDomainMxSeen(key);
      } catch (err) {
        console.warn(`domain_mx_cache increment failed for ${key}:`, err?.message || err);
      }
      return cacheRowToResult(cached, key);
    }
  } catch (err) {
    console.warn(`domain_mx_cache read failed for ${key}:`, err?.message || err);
  }

  const { hosts, error } = await resolveMxHosts(key, resolveFn);
  const classified = classifyMxHosts(hosts);
  const result = {
    domain: key,
    mx_host: classified.mx_host,
    mx_hosts: hosts.join(','),
    mail_class: classified.mail_class,
    gateway_provider: classified.gateway_provider,
    behind_gateway: classified.behind_gateway,
    lookup_error: error,
    cached: false,
  };

  try {
    await upsertDomainMxCache({
      domain: key,
      mx_host: result.mx_host,
      mx_hosts: result.mx_hosts,
      mail_class: result.mail_class,
      gateway_provider: result.gateway_provider,
      lookup_error: result.lookup_error,
    });
  } catch (err) {
    console.warn(`domain_mx_cache write failed for ${key}:`, err?.message || err);
  }

  return result;
}

export async function classifyEmailsByMx(
  emails,
  { onProgress, resolveFn, concurrency = DEFAULT_CONCURRENCY } = {}
) {
  const byEmail = new Map();
  const uniqueDomains = [];
  const domainToEmails = new Map();

  for (const raw of emails) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email) continue;
    const domain = extractDomain(email);
    if (!domainToEmails.has(domain)) {
      domainToEmails.set(domain, []);
      if (domain) uniqueDomains.push(domain);
    }
    domainToEmails.get(domain).push(email);
  }

  let cachedHits = 0;
  let lookedUp = 0;
  let next = 0;
  const resultsByDomain = new Map();

  async function worker() {
    while (next < uniqueDomains.length) {
      const i = next;
      next += 1;
      const domain = uniqueDomains[i];
      const result = await lookupDomainMx(domain, { resolveFn });
      resultsByDomain.set(domain, result);
      if (result.cached) cachedHits += 1;
      else lookedUp += 1;
      if (onProgress && (i + 1) % 25 === 0) {
        await onProgress(
          `MX lookup ${i + 1}/${uniqueDomains.length} domains (cache hits=${cachedHits}, fresh=${lookedUp})`
        );
      }
      if (!result.cached) await sleep(15);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, uniqueDomains.length)) },
    () => worker()
  );
  await Promise.all(workers);

  for (const [domain, addrs] of domainToEmails) {
    const result =
      resultsByDomain.get(domain) ||
      {
        domain,
        mx_host: null,
        mx_hosts: '',
        mail_class: MAIL_CLASS.UNKNOWN,
        gateway_provider: 'none',
        behind_gateway: false,
        lookup_error: domain ? null : 'missing_domain',
        cached: false,
      };
    for (const email of addrs) {
      byEmail.set(email, result);
    }
  }

  return {
    byEmail,
    uniqueDomains: uniqueDomains.length,
    cachedHits,
    lookedUp,
  };
}

export function mxRecordFromLookup(lookup) {
  if (!lookup) {
    return {
      domain: null,
      mail_class: MAIL_CLASS.UNKNOWN,
      gateway_provider: 'none',
      mx_host: null,
      behind_gateway: false,
    };
  }
  return {
    domain: lookup.domain,
    mail_class: lookup.mail_class,
    gateway_provider: lookup.gateway_provider,
    mx_host: lookup.mx_host,
    behind_gateway: Boolean(lookup.behind_gateway),
  };
}
