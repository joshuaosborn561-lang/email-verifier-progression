/**
 * Stall / failure salvage policy.
 *
 * Never start a fresh run on a file that already has a run until
 * get_verification_results.resolved_counts has been read. A failed run is
 * not an empty run.
 */

import { countRunMvVerdicts } from './mv-coverage.js';

const STALL_RE =
  /file_id=(\d+)[^\n]*percent=(\d+)[^\n]*verified=(\d+)[^\n]*unverified=(\d+)/i;

export function parseMvStallError(text) {
  const m = String(text || '').match(STALL_RE);
  if (!m) return null;
  return {
    fileId: m[1],
    percent: Number(m[2]),
    verified: Number(m[3]),
    unverified: Number(m[4]),
  };
}

export function usefulOutputCount(run, resolvedCounts) {
  const fromRun = Number(run?.final_sendable_count);
  if (Number.isFinite(fromRun) && fromRun > 0) return fromRun;
  return Number(resolvedCounts?.sendable) || 0;
}

/**
 * Decide what an operator / agent must do next. Read resolved_counts first.
 *
 * - fresh_ok: every MV verdict count is 0 — nothing paid to salvage
 * - resume: MV work exists and N2B/merge did not finish — do not restart
 * - salvage: some sendable/rejected exist; remainder only for a new file
 * - done: run already produced useful output
 */
export function salvageDecision({ run, resolvedCounts } = {}) {
  const counts = resolvedCounts || {};
  const sendable = Number(counts.sendable) || 0;
  const rejected = Number(counts.rejected) || 0;
  const pending = Number(counts.pending) || 0;
  const awaitingN2b = Number(counts.awaiting_n2b) || 0;
  const mvOk = Number(counts.mv_ok ?? run?.mv_ok_count) || 0;
  const assessed = countRunMvVerdicts({
    mv_ok_count: counts.mv_ok ?? run?.mv_ok_count,
    mv_catch_all_count: counts.mv_catch_all ?? run?.mv_catch_all_count,
    mv_unknown_count: counts.mv_unknown ?? run?.mv_unknown_count,
    mv_invalid_count: counts.mv_invalid ?? run?.mv_invalid_count,
  }).assessed;
  const useful = usefulOutputCount(run, counts);
  const stall = parseMvStallError(run?.last_error || run?.error_message);
  const retries = Number(run?.retry_count) || 0;
  const stuckFile = Boolean(stall) && retries >= 2;

  const base = {
    useful_output_count: useful,
    mv_assessed: assessed,
    remainder_estimate: pending,
    stall,
    retry_count: retries,
    do_not_resume: stuckFile,
  };

  if (assessed === 0 && sendable === 0 && rejected === 0) {
    return {
      ...base,
      action: 'fresh_ok',
      reason:
        'MillionVerifier never returned verdicts. Nothing to salvage. ' +
        'This is a failed run, not N processed records. ' +
        (stuckFile
          ? 'Do not resume again — the MV file is unmoving. Start a fresh run on a re-exported file.'
          : 'A fresh run is allowed after re-exporting so deletions are not re-verified. ' +
            'mv_credits_used=0 cannot by itself confirm the first pass did not bill.'),
    };
  }

  if (awaitingN2b > 0) {
    return {
      ...base,
      action: 'resume',
      reason:
        'MillionVerifier finished and No2Bounce did not. Resume this run — do not start a fresh MV pass.',
    };
  }

  if (mvOk > 0 && sendable === 0) {
    return {
      ...base,
      action: 'resume',
      reason: 'Merge did not finish but MV verdicts are intact. Resume — merge is local and free.',
    };
  }

  if (sendable + rejected > 0 && pending > 0) {
    return {
      ...base,
      action: 'salvage',
      reason:
        `Real verdicts exist (sendable=${sendable}, rejected=${rejected}, pending=${pending}). ` +
        'Ingest sendable_url and rejected_url server-to-server, then start a fresh run only on ev_status-null remainder.',
    };
  }

  if (useful > 0 && pending === 0) {
    return {
      ...base,
      action: 'done',
      reason: `Run produced ${useful} verified sendable addresses.`,
    };
  }

  return {
    ...base,
    action: assessed > 0 ? 'resume' : 'fresh_ok',
    reason:
      assessed > 0
        ? 'Verdicts exist; resume rather than starting a second MV pass.'
        : 'No MV verdicts to salvage.',
  };
}

export function shouldRefuseUnmovingResume(run, { force = false } = {}) {
  if (force) return false;
  const stall = parseMvStallError(run?.last_error || run?.error_message);
  if (!stall) return false;
  return (Number(run?.retry_count) || 0) >= 2;
}

export function unmovingStallResumeError(run) {
  const stall = parseMvStallError(run?.last_error || run?.error_message);
  const retries = Number(run?.retry_count) || 0;
  const fileBit = stall ? `file_id=${stall.fileId}` : 'this MillionVerifier file';
  const stats = stall
    ? `percent=${stall.percent}, verified=${stall.verified}`
    : 'percent/verified unchanged';
  return (
    `Refusing resume: ${fileBit} is genuinely stuck (${stats}) after ${retries} resumes. ` +
    'Another resume reproduces the same failure. Call get_verification_results and read resolved_counts. ' +
    'If every verdict count is 0, start a fresh run on a re-exported file.'
  );
}
