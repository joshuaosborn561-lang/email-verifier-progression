/**
 * Helpers for "did MillionVerifier actually produce verdicts?"
 * A run with zero assessed rows must never look like a completed rejection.
 */

export const MV_RESULTS = ['ok', 'catch_all', 'unknown', 'invalid'];

export function emptyMvTallies() {
  return { ok: 0, catch_all: 0, unknown: 0, invalid: 0, assessed: 0 };
}

export function countPersistedMvVerdicts(rows) {
  const tallies = emptyMvTallies();
  for (const row of rows || []) {
    if (MV_RESULTS.includes(row.mv_result)) {
      tallies[row.mv_result] += 1;
      tallies.assessed += 1;
    }
  }
  return tallies;
}

export function countMvMapVerdicts(mvResults) {
  const tallies = emptyMvTallies();
  for (const value of mvResults?.values?.() || []) {
    const result = value?.result;
    if (MV_RESULTS.includes(result) && !value?.unverified) {
      tallies[result] += 1;
      tallies.assessed += 1;
    }
  }
  return tallies;
}

export function countRunMvVerdicts(run) {
  const ok = Number(run?.mv_ok_count) || 0;
  const catch_all = Number(run?.mv_catch_all_count) || 0;
  const unknown = Number(run?.mv_unknown_count) || 0;
  const invalid = Number(run?.mv_invalid_count) || 0;
  return {
    ok,
    catch_all,
    unknown,
    invalid,
    assessed: ok + catch_all + unknown + invalid,
  };
}

function tallyClose(got, expected) {
  const exp = Number(expected) || 0;
  if (exp === 0) return got === 0;
  return Math.abs(got - exp) <= Math.max(25, Math.floor(exp * 0.05));
}

/**
 * Persisted address rows are usable only when MillionVerifier actually
 * classified them. MX-only rows (all mv_result null, all run tallies 0)
 * are NOT coverage — that was the silent 100% reject bug.
 */
export function hasUsableMvCoverage({ addressRows, run, expectedCount }) {
  const tallies = countPersistedMvVerdicts(addressRows);
  if (tallies.assessed === 0) return false;
  const expected = Math.max(
    Number(expectedCount) || 0,
    countRunMvVerdicts(run).assessed,
    (addressRows || []).length
  );
  if (expected > 0 && tallies.assessed < Math.floor(expected * 0.5)) return false;
  return (
    (addressRows || []).length > 0 &&
    tallyClose(tallies.ok, run?.mv_ok_count) &&
    tallyClose(tallies.catch_all, run?.mv_catch_all_count) &&
    tallyClose(tallies.unknown, run?.mv_unknown_count) &&
    tallyClose(tallies.invalid, run?.mv_invalid_count)
  );
}

export function isCorruptCompletedRun(run) {
  const total = Number(run?.total_emails) || 0;
  if (total <= 0) return false;
  if (run?.status !== 'completed') return false;
  return countRunMvVerdicts(run).assessed === 0;
}

export function zeroVerdictsError({ totalEmails, fileId }) {
  const fileBit = fileId ? ` (file_id=${fileId})` : '';
  return (
    `MillionVerifier produced no verdicts for ${totalEmails} addresses${fileBit}. ` +
    'Refusing to mark unverified rows as rejected. Resume will retry the result download without re-uploading.'
  );
}

export function shouldRecoverPartial(fileinfo, { stalled = false, recoverPercent = 90 } = {}) {
  const percent = Number(fileinfo?.percent ?? 0);
  const verified = Number(fileinfo?.verified ?? 0);
  return stalled && percent >= recoverPercent && verified > 0;
}
