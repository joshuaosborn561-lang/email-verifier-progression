# VerifyFall — Email Verification Waterfall

Node.js/Express dashboard + MCP server that runs an email verification waterfall:

0. **MX / SEG tagging** (free, cache-first) — resolve each domain’s mail exchanger and tag the contact (`seg` / `native_filter` / `direct` / `unknown`). Nothing is dropped, deprioritised, or filtered.
1. **MillionVerifier** (bulk file API) — classify `ok` / `catch_all` / `unknown` / `invalid`
2. **no2bounce** — re-check `catch_all` and `unknown` as **separate cohorts** (batched submits)
3. **Merge** — final sendable = MV `ok` + No2Bounce-confirmed catch-alls + No2Bounce-confirmed unknowns; everything else rejected. Addresses with no verdict from either vendor increment `unresolved_after_n2b`. Campaign staging also writes `_SENDABLE_SEG.csv` (third-party gateway) and `_SENDABLE_OTHER.csv` (everyone else) so bounce/reply rates can be measured separately. Combined `_SENDABLE.csv` is unchanged.

CSV columns are preserved; added columns are `verification_source`, `verification_status`, `confidence`, `behind_gateway`, `mail_class`, `gateway_provider`, `mx_host`, and `campaign_split`.

`mail_class` is `seg` (Proofpoint / Mimecast / Barracuda / Cisco / etc.), `native_filter` (Google or Microsoft’s own MX), `direct` (any other MX), or `unknown` (no MX / lookup failed). Google and Microsoft are **not** lumped in with third-party gateways. The raw MX host is kept so unmatched hosts can grow the provider list from real data.

Domain answers are persisted in `domain_mx_cache` and reused across clients and runs.

## Stack

- Express dashboard (static SPA)
- Supabase Postgres + Storage (`verification-uploads`, `verification-results`)
- MCP Streamable HTTP at `POST /mcp`
- Deploy target: Railway (`verifyfall-production.up.railway.app`)

## Environment

| Variable | Description |
|---|---|
| `MILLIONVERIFIER_API_KEY` | MillionVerifier API key |
| `NO2BOUNCE_API_TOKEN` | no2bounce API token |
| `SUPABASE_URL` | `https://azpapwtnrbzywlnxxecz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `PORT` | Optional (default `3000`) |
| `PUBLIC_URL` | Optional public base URL |
| `N2B_SUBMIT_BATCH_SIZE` | Optional No2Bounce submit chunk size (default `150`) |
| `MV_STALL_TIMEOUT_MS` | Fail/recover if MV progress is unchanged this long (default `720000` = 12m) |
| `MV_PARTIAL_RECOVER_PERCENT` | Start polling the MV result file and recover a stall at or above this percent (default `90`) |

## Local run

```bash
npm install
cp .env.example .env   # fill in secrets
node --env-file=.env src/server.js
```

Open `http://localhost:3000`.

## MCP tools

Endpoint: `POST /mcp` (Streamable HTTP). Responses are summary-only — never full result arrays.

| Tool | Returns |
|---|---|
| `start_verification(file_url, segment_name, prior_run_id?, force_fresh?)` | `{ run_id }` immediately. Pass `prior_run_id` whenever a run already exists for the file. |
| `get_verification_status(run_id)` | status + counts + credits + `useful_output_count` |
| `list_verification_runs(limit?)` | recent compact rows |
| `get_verification_results(run_id)` | signed URLs + `resolved_counts` + `salvage_decision`; partial for non-completed runs |
| `resume_verification(run_id)` | resume from last completed stage; refuses a third unmoving MV stall |
| `export_all_sendable(run_ids)` | zip of SENDABLE CSVs → signed URL |

**Salvage first.** Never start a fresh run on a file that already has a run until `get_verification_results` has been read. See [STALL_RECOVERY.md](STALL_RECOVERY.md).

## Resume & partial results

Per-address MillionVerifier results are persisted before No2Bounce starts. Failed or paused runs keep that work; `resume_verification` continues from `stage_completed` (`none` → `mx` → `mv` → `n2b` → `merge`) and will not re-bill MillionVerifier when `mv_file_id` / address rows already exist. MX tagging is free and is skipped for addresses that already have a `mail_class`.

A run where MillionVerifier produced **no verdicts** ends `failed` with `last_error` — never `completed` with everyone rejected. Rows the verifier never assessed land in `_UNRESOLVED.csv`. If MillionVerifier stalls at ≥90% (`MV_PARTIAL_RECOVER_PERCENT`, default 90; stall window `MV_STALL_TIMEOUT_MS`, default 12m), the result file is downloaded and the unverified remainder is sent to No2Bounce as `unknown`.

`get_verification_results` returns `{ partial: true, ... }` for failed, paused, and in-progress runs, with per-stage counts and any downloadable partial CSVs.

## Credit ceilings

Credit-ceiling pauses are **disabled by default** so every `start_verification` run completes the full waterfall (MV → No2Bounce → merge). Optional env overrides:

- `MV_BALANCE_FRACTION_CEILING` — e.g. `0.5` to pause before Stage 1 if projected usage exceeds that fraction of remaining MV balance
- `N2B_DAILY_CREDIT_CEILING` — e.g. `19000` to pause before Stage 2 if today's N2B usage + candidates would exceed it

`mv_credits_used` is sourced from MillionVerifier file tallies (`ok + invalid`); `n2b_credits_used` from No2Bounce `creditDebited`.

## API (dashboard)

- `GET /api/health`
- `GET /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/results`
- `POST /api/runs/:id/resume` (also `/retry`)
- `POST /api/upload` (multipart `files`)
- `GET /export/bulk?run_ids=uuid1,uuid2` (also `/api/export/bulk`) — zip SENDABLE CSVs → signed URL

## Tests

```bash
npm test
```
