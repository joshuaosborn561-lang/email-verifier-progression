import {
  isAcceptAllDeliverable,
  isStrictDeliverable,
} from './providers/no2bounce.js';
import { campaignSplit, MAIL_CLASS } from './mx.js';

/**
 * Decide final disposition for one address after MV (+ optional N2B).
 *
 * Rules:
 * - MV ok → sendable / confirmed
 * - MV invalid → rejected
 * - MV catch_all | unknown → require N2B:
 *   - strict deliverable → sendable / confirmed
 *   - accept-all deliverable → sendable / unresolved_catchall
 *   - no verdict / unknown → rejected + unresolved_after_n2b
 *   - other N2B reject → rejected
 */
export function resolveAddressOutcome(mvResult, n2bResult, { assessed = true } = {}) {
  if (!assessed) {
    return {
      final_disposition: 'unresolved',
      confidence: 'unverified',
      verification_source: null,
      verification_status: 'never_verified',
      unresolved_after_n2b: false,
    };
  }

  const mv = String(mvResult || 'unknown').toLowerCase();

  if (mv === 'ok') {
    return {
      final_disposition: 'sendable',
      confidence: 'confirmed',
      verification_source: 'millionverifier',
      verification_status: 'ok',
      unresolved_after_n2b: false,
    };
  }

  if (mv === 'invalid') {
    return {
      final_disposition: 'rejected',
      confidence: 'rejected',
      verification_source: 'millionverifier',
      verification_status: 'invalid',
      unresolved_after_n2b: false,
    };
  }

  // catch_all or unknown — second vendor decides
  if (!n2bResult) {
    return {
      final_disposition: 'pending',
      confidence: null,
      verification_source: 'millionverifier',
      verification_status: mv,
      unresolved_after_n2b: false,
    };
  }

  const status = String(n2bResult.status || 'unknown').trim();
  const statusNorm = status.toLowerCase();

  if (isStrictDeliverable(status)) {
    return {
      final_disposition: 'sendable',
      confidence: 'confirmed',
      verification_source: 'no2bounce',
      verification_status: status,
      unresolved_after_n2b: false,
    };
  }

  if (isAcceptAllDeliverable(status)) {
    return {
      final_disposition: 'sendable',
      confidence: 'unresolved_catchall',
      verification_source: 'no2bounce',
      verification_status: status,
      unresolved_after_n2b: false,
    };
  }

  const noVerdict =
    !status ||
    statusNorm === 'unknown' ||
    statusNorm === 'no_verdict' ||
    statusNorm === 'unverifiable' ||
    n2bResult.noVerdict === true;

  return {
    final_disposition: 'rejected',
    confidence: 'rejected',
    verification_source: 'no2bounce',
    verification_status: status || 'unknown',
    unresolved_after_n2b: noVerdict,
  };
}

/**
 * Build sendable/rejected row arrays and aggregate counters from MV + N2B maps.
 */
function attachMxTags(out, mx) {
  const mailClass = mx?.mail_class || MAIL_CLASS.UNKNOWN;
  const behind = Boolean(mx?.behind_gateway || mailClass === MAIL_CLASS.SEG);
  out.behind_gateway = behind ? 'yes' : 'no';
  out.mail_class = mailClass;
  out.gateway_provider = mx?.gateway_provider || 'none';
  out.mx_host = mx?.mx_host || '';
  out.campaign_split = campaignSplit(mailClass);
  return out;
}

export function mergeRunResults({ records, emailCol, mvResults, n2bResults, mxByEmail }) {
  const sendable = [];
  const rejected = [];
  const unresolved = [];
  const sendableSeg = [];
  const sendableOther = [];
  let confirmedCount = 0;
  let unresolvedCatchallCount = 0;
  let unresolvedAfterN2b = 0;
  let neverVerified = 0;

  for (const row of records) {
    const email = String(row[emailCol] || '').trim().toLowerCase();
    const mvRow = mvResults?.get(email) || null;
    const assessed = Boolean(mvRow && mvRow.result);
    const n2b = n2bResults?.get(email) || null;
    const outcome = resolveAddressOutcome(mvRow?.result, n2b, { assessed });
    const mx = mxByEmail?.get(email) || null;

    const out = attachMxTags(
      {
        ...row,
        verification_source: outcome.verification_source,
        verification_status: outcome.verification_status,
        confidence: outcome.confidence || (outcome.final_disposition === 'unresolved' ? 'unverified' : 'rejected'),
      },
      mx
    );

    if (outcome.final_disposition === 'sendable') {
      sendable.push(out);
      if (out.campaign_split === 'seg') sendableSeg.push(out);
      else sendableOther.push(out);
      if (outcome.confidence === 'confirmed') confirmedCount += 1;
      if (outcome.confidence === 'unresolved_catchall') unresolvedCatchallCount += 1;
    } else if (outcome.final_disposition === 'unresolved') {
      unresolved.push(out);
      neverVerified += 1;
    } else if (outcome.final_disposition === 'pending') {
      // Assessed catch_all/unknown still waiting on N2B — not a silent reject of unverified rows
      out.confidence = 'pending';
      unresolved.push(out);
      unresolvedAfterN2b += 1;
    } else {
      rejected.push(out);
      if (outcome.unresolved_after_n2b) unresolvedAfterN2b += 1;
    }
  }

  return {
    sendable,
    rejected,
    unresolved,
    sendableSeg,
    sendableOther,
    confirmedCount,
    unresolvedCatchallCount,
    unresolvedAfterN2b,
    neverVerified,
  };
}

export function normalizeMvResult(raw) {
  let result = String(raw || '').trim().toLowerCase();
  if (result === 'catchall') result = 'catch_all';
  if (result === 'valid' || result === 'good') result = 'ok';
  if (!['ok', 'catch_all', 'unknown', 'invalid'].includes(result)) {
    if (result === 'disposable') result = 'invalid';
    else result = 'unknown';
  }
  return result;
}
