# Email Verifier Progression: stall recovery

Paste this when a verification run fails, stalls, or pauses. It exists because on
2026-09-09 a Parlay run of 11,021 records failed twice and got restarted from scratch
without anyone checking whether the completed stages held salvageable data first.

---

## The rule

**Never start a fresh verification run on a file that already has a run against it
until you have called `get_verification_results` on the failed run and read
`resolved_counts` / `salvage_decision`.**

A failed run is not an empty run. `get_verification_results` returns partial results
from every completed stage, labelled `partial: true`. Restarting without checking
throws away verdicts you already paid for and bills MillionVerifier a second time
for the same addresses.

`start_verification` now takes `prior_run_id`. The server refuses a fresh start when
`salvage_decision.action` is `resume` or `salvage` unless `force_fresh=true`.

---

## Diagnostic ladder

Run these in order. Stop as soon as one resolves the situation.

### 1. Read the failure

`get_verification_status(run_id)`

Pull four things out of `last_error` and the body:

- `stage_completed` ... how far it actually got (`none` / `mx` / `mv` / `n2b`)
- `retry_count` ... how many resumes have already been burned
- MV `file_id`, `percent`, `verified`, `result_counts` from the error string
- `mv_credits_used` and `n2b_credits_used`

### 2. Check for salvage before anything else

`get_verification_results(run_id)`

Read `resolved_counts` and `salvage_decision`. This is the whole decision:

| `resolved_counts` shows | Meaning | Action |
|---|---|---|
| `pending` equals `total`, all verdict counts 0 | MV never returned verdicts. Nothing to salvage. | `fresh_ok` — safe to start a fresh run on a **re-exported** file |
| `sendable` + `rejected` > 0, some `pending` | Real verdicts exist | **`salvage`.** Go to step 4 |
| `awaiting_n2b` > 0 | MV finished, No2Bounce did not | **`resume`, do not restart.** MV is already paid for |
| `mv_ok` > 0 but `sendable` is 0 | Merge stage failed, verdicts intact | **`resume`**, merge is cheap and local |

### 3. Resume policy

`resume_verification(run_id)` reloads the existing `mv_file_id` without re-billing.

- Resume once. Wait, then re-check status.
- Resume a second time **only if** `percent` or `verified` moved between attempts.
- If `percent` and `verified` are identical across two failures, the MV file is
  genuinely stuck. Resuming again reproduces the same failure. The server refuses
  a third resume (`retry_count >= 2` on an unmoving stall).
- Never resume more than twice on an unmoving file.

### 4. Partial salvage, when verdicts exist

Do not re-verify addresses that already have a verdict.

1. Pull `sendable_url` and `rejected_url` from `get_verification_results`.
   Signed URLs expire in one hour, so use them immediately or re-call the tool.
2. Ingest both back into the client table server to server. Write `ev_status`.
   Rows never pass through chat.
3. Export **only** rows where `ev_status is null` to a new signed CSV.
4. Start a fresh run on that remainder file alone, passing `prior_run_id`.

State the remainder count and its cost before running it.

### 5. When a fresh full run is genuinely required

Only when step 2 shows everything `pending` / `salvage_decision.action=fresh_ok`. Before starting:

- Re-export from the client table so the file reflects any deletions made since the
  original export. A stale file re-verifies rows you have already cut.
- State out loud that this is a second MV pass, and whether the first one billed.
  If `mv_credits_used` is 0 the first pass likely did not bill, but say that it
  cannot be confirmed from inside the tool rather than asserting it.
- Pass `prior_run_id` and `force_fresh=true` only in this case.

---

## What is free and never needs redoing

MX classification is free and cached server side. A restart shows
`mx_cache_hits` high and `mx_lookups` at or near 0. Never treat lost MX work as a
reason to avoid restarting, and never count it as spend.

`mail_class_seg_count` is the SEG versus non-SEG split. It survives a failed run and
is usable for campaign sizing even when no verdicts exist.

---

## Reporting

Report `useful_output_count`, meaning verified sendable addresses. Never report rows
submitted. A run that processed 11,021 records and returned 0 verdicts is a failed
run, and should be described as one plainly rather than as 11,021 records processed.

---

## Reference case, 2026-09-09

Run `f00a6c5c-b60b-43cb-aa5f-1cbf8c146dd6`, Parlay, 11,021 records.

- MV file 32034648 stalled at `percent=95`, `verified=10278`, `unverified=447`,
  `result_counts=0`, twice, twelve minutes each.
- `retry_count` reached 2 with `percent` unmoved between attempts, which is the
  signature of a genuinely stuck file.
- `get_verification_results` returned `partial: true` with `resolved_counts.total`
  10,725, all `pending`, every verdict count 0. No salvage available.
- MX survived: `mx_cache_hits` 10,278, `mx_lookups` 0. SEG split 2,169 behind
  gateway held good.
- Correct action was a fresh run, but on a re-exported file, because 1,214 rows had
  been deleted from the table after the original export
  (`b7379d65-c2fa-4a74-88e7-64752ad4a67e`, 9,807 rows).
