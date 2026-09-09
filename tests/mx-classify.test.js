import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignSplit,
  classifyMxHosts,
  extractDomain,
  MAIL_CLASS,
  summarizeMailClasses,
} from '../src/mx.js';
import { mergeRunResults } from '../src/merge.js';

describe('extractDomain', () => {
  it('pulls the domain from an email', () => {
    assert.equal(extractDomain('Pat@Acme.COM'), 'acme.com');
  });

  it('returns null for junk', () => {
    assert.equal(extractDomain('not-an-email'), null);
    assert.equal(extractDomain(''), null);
  });
});

describe('classifyMxHosts', () => {
  it('tags Proofpoint as seg', () => {
    const out = classifyMxHosts(['mx1.pphosted.com', 'mx2.pphosted.com']);
    assert.equal(out.mail_class, MAIL_CLASS.SEG);
    assert.equal(out.gateway_provider, 'proofpoint');
    assert.equal(out.behind_gateway, true);
    assert.equal(out.mx_host, 'mx1.pphosted.com');
    assert.equal(campaignSplit(out.mail_class), 'seg');
  });

  it('tags Mimecast, Barracuda, and Cisco as seg', () => {
    assert.equal(classifyMxHosts(['eu-smtp-inbound-1.mimecast.com']).gateway_provider, 'mimecast');
    assert.equal(classifyMxHosts(['d123456.ess.barracudanetworks.com']).gateway_provider, 'barracuda');
    assert.equal(classifyMxHosts(['cluster5.us.iphmx.com']).gateway_provider, 'cisco');
  });

  it('treats Google Workspace MX as native_filter, not seg', () => {
    const out = classifyMxHosts(['aspmx.l.google.com', 'alt1.aspmx.l.google.com']);
    assert.equal(out.mail_class, MAIL_CLASS.NATIVE);
    assert.equal(out.gateway_provider, 'google');
    assert.equal(out.behind_gateway, false);
    assert.equal(campaignSplit(out.mail_class), 'other');
  });

  it('treats Microsoft 365 MX as native_filter, not seg', () => {
    const out = classifyMxHosts(['acme-com.mail.protection.outlook.com']);
    assert.equal(out.mail_class, MAIL_CLASS.NATIVE);
    assert.equal(out.gateway_provider, 'microsoft');
    assert.equal(out.behind_gateway, false);
  });

  it('classifies an unmatched MX host as direct and keeps the raw host', () => {
    const out = classifyMxHosts(['mail.obscure-msp.example']);
    assert.equal(out.mail_class, MAIL_CLASS.DIRECT);
    assert.equal(out.gateway_provider, 'none');
    assert.equal(out.mx_host, 'mail.obscure-msp.example');
    assert.equal(out.behind_gateway, false);
  });

  it('classifies missing MX as unknown', () => {
    const out = classifyMxHosts([]);
    assert.equal(out.mail_class, MAIL_CLASS.UNKNOWN);
    assert.equal(out.mx_host, null);
    assert.equal(out.behind_gateway, false);
  });

  it('prefers SEG when any MX is a third-party gateway', () => {
    const out = classifyMxHosts(['aspmx.l.google.com', 'mxa-00001234.ppe-hosted.com']);
    assert.equal(out.mail_class, MAIL_CLASS.SEG);
    assert.equal(out.gateway_provider, 'proofpoint');
    assert.equal(out.behind_gateway, true);
  });
});

describe('campaign split never drops a sendable contact', () => {
  it('puts SEG sendable in SENDABLE_SEG and everyone else in SENDABLE_OTHER', () => {
    const records = [
      { Email: 'seg@it.example' },
      { Email: 'google@it.example' },
      { Email: 'direct@it.example' },
      { Email: 'bad@it.example' },
    ];
    const mvResults = new Map([
      ['seg@it.example', { result: 'ok' }],
      ['google@it.example', { result: 'ok' }],
      ['direct@it.example', { result: 'ok' }],
      ['bad@it.example', { result: 'invalid' }],
    ]);
    const mxByEmail = new Map([
      ['seg@it.example', { mail_class: 'seg', gateway_provider: 'proofpoint', mx_host: 'mx1.pphosted.com', behind_gateway: true }],
      ['google@it.example', { mail_class: 'native_filter', gateway_provider: 'google', mx_host: 'aspmx.l.google.com', behind_gateway: false }],
      ['direct@it.example', { mail_class: 'direct', gateway_provider: 'none', mx_host: 'mail.obscure.example', behind_gateway: false }],
    ]);

    const merged = mergeRunResults({
      records,
      emailCol: 'Email',
      mvResults,
      n2bResults: new Map(),
      mxByEmail,
    });

    assert.equal(merged.sendable.length, 3);
    assert.equal(merged.sendableSeg.length + merged.sendableOther.length, merged.sendable.length);
    assert.deepEqual(
      merged.sendableSeg.map((r) => r.Email),
      ['seg@it.example']
    );
    assert.deepEqual(
      merged.sendableOther.map((r) => r.Email).sort(),
      ['direct@it.example', 'google@it.example']
    );
    assert.equal(merged.sendableSeg[0].behind_gateway, 'yes');
    assert.equal(merged.sendableSeg[0].mail_class, 'seg');
    assert.equal(merged.sendableSeg[0].mx_host, 'mx1.pphosted.com');
    assert.equal(merged.sendableOther.find((r) => r.Email === 'google@it.example').mail_class, 'native_filter');
    assert.ok(merged.rejected.some((r) => r.Email === 'bad@it.example'));
  });
});

describe('summarizeMailClasses', () => {
  it('counts each class without dropping rows', () => {
    const counts = summarizeMailClasses([
      { mail_class: 'seg', behind_gateway: true, domain: 'a.com' },
      { mail_class: 'native_filter', domain: 'b.com' },
      { mail_class: 'direct', domain: 'a.com' },
      { mail_class: 'unknown', domain: null },
    ]);
    assert.equal(counts.seg, 1);
    assert.equal(counts.native_filter, 1);
    assert.equal(counts.direct, 1);
    assert.equal(counts.unknown, 1);
    assert.equal(counts.behind_gateway, 1);
    assert.equal(counts.domains, 2);
  });
});
