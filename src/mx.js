/**
 * Secure-email-gateway classification from MX hosts.
 * Tag-and-split only — never filter, deprioritise, or drop a contact.
 *
 * mail_class:
 *   seg            — third-party gateway (Proofpoint, Mimecast, Barracuda, Cisco, …)
 *   native_filter  — Google Workspace / Microsoft 365 native MX
 *   direct         — everything else with a usable MX
 *   unknown        — no MX / lookup failed
 */

export const MAIL_CLASS = {
  SEG: 'seg',
  NATIVE: 'native_filter',
  DIRECT: 'direct',
  UNKNOWN: 'unknown',
};

const SEG_PROVIDERS = [
  { provider: 'proofpoint', needles: ['pphosted.com', 'ppe-hosted.com', 'proofpoint.com', 'pphosted'] },
  { provider: 'mimecast', needles: ['mimecast.com', 'mimecast-offshore.com'] },
  { provider: 'barracuda', needles: ['barracudanetworks.com', 'barracuda.com', 'cuda.barracuda'] },
  { provider: 'cisco', needles: ['iphmx.com', 'ironport.com', 'ces.cisco.com', 'cisco-cloud.com'] },
  { provider: 'trend_micro', needles: ['tmes.trendmicro.com', 'tmes.trendmicro.eu', 'trendmicro.com'] },
  { provider: 'fortinet', needles: ['fortimail.com', 'fortinet.com'] },
  { provider: 'sophos', needles: ['sophos.com', 'hydra.sophos.com'] },
  { provider: 'symantec', needles: ['messagelabs.com', 'symanteccloud.com'] },
  { provider: 'fireeye', needles: ['fireeyecloud.com', 'fireeye.com'] },
  { provider: 'appriver', needles: ['appriver.com', 'zixmail.net', 'zixsmbhc.com'] },
  { provider: 'hornetsecurity', needles: ['hornetsecurity.com', 'antispameurope.com'] },
  { provider: 'forcepoint', needles: ['mailcontrol.com', 'forcepoint.com'] },
  { provider: 'mailprotector', needles: ['mailprotector.com', 'mpmailmx.com'] },
  { provider: 'spamtitan', needles: ['spamtitan.com'] },
];

const NATIVE_PROVIDERS = [
  {
    provider: 'google',
    needles: [
      'aspmx.l.google.com',
      'googlemail.com',
      'gmail-smtp-in.l.google.com',
      'google.com',
    ],
  },
  {
    provider: 'microsoft',
    needles: [
      'mail.protection.outlook.com',
      'protection.outlook.com',
      'olc.protection.outlook.com',
    ],
  },
];

export function extractDomain(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 0 || at === value.length - 1) return null;
  const domain = value.slice(at + 1).replace(/\.$/, '');
  if (!domain || !domain.includes('.')) return null;
  return domain;
}

function hostMatches(host, needles) {
  const h = String(host || '').toLowerCase();
  return needles.some((n) => {
    if (!n) return false;
    if (h === n || h.endsWith(`.${n}`)) return true;
    // Token match for short labels like "pphosted" without catching "notpphosted.com"
    return h.includes(`.${n}.`) || h.startsWith(`${n}.`);
  });
}

export function classifyMxHosts(mxHosts) {
  const hosts = (mxHosts || [])
    .map((h) => String(h || '').trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);

  if (!hosts.length) {
    return {
      mail_class: MAIL_CLASS.UNKNOWN,
      gateway_provider: 'none',
      mx_host: null,
      behind_gateway: false,
    };
  }

  const primary = hosts[0];

  for (const { provider, needles } of SEG_PROVIDERS) {
    if (hosts.some((h) => hostMatches(h, needles))) {
      return {
        mail_class: MAIL_CLASS.SEG,
        gateway_provider: provider,
        mx_host: hosts.find((h) => hostMatches(h, needles)) || primary,
        behind_gateway: true,
      };
    }
  }

  for (const { provider, needles } of NATIVE_PROVIDERS) {
    if (hosts.some((h) => hostMatches(h, needles))) {
      return {
        mail_class: MAIL_CLASS.NATIVE,
        gateway_provider: provider,
        mx_host: hosts.find((h) => hostMatches(h, needles)) || primary,
        behind_gateway: false,
      };
    }
  }

  return {
    mail_class: MAIL_CLASS.DIRECT,
    gateway_provider: 'none',
    mx_host: primary,
    behind_gateway: false,
  };
}

export function campaignSplit(mailClass) {
  return mailClass === MAIL_CLASS.SEG ? 'seg' : 'other';
}

export function summarizeMailClasses(rows) {
  const counts = {
    seg: 0,
    native_filter: 0,
    direct: 0,
    unknown: 0,
    behind_gateway: 0,
    domains: 0,
  };
  const domains = new Set();
  for (const row of rows) {
    const klass = row.mail_class || MAIL_CLASS.UNKNOWN;
    if (counts[klass] !== undefined) counts[klass] += 1;
    if (row.behind_gateway || klass === MAIL_CLASS.SEG) counts.behind_gateway += 1;
    if (row.domain) domains.add(row.domain);
  }
  counts.domains = domains.size;
  return counts;
}

export function mxTagColumns() {
  return ['behind_gateway', 'mail_class', 'gateway_provider', 'mx_host'];
}
