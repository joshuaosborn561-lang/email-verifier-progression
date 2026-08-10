# VerifyFall — Email Verification Waterfall

Node.js/Express dashboard + MCP server that runs an email verification waterfall:

1. **MillionVerifier** (bulk file API) — classify `ok` / `catch_all` / `unknown` / `invalid`
2. **no2bounce** — re-check `catch_all` and `unknown` as **separate cohorts** (batched submits)
3. **Merge** — final sendable = MV `ok` + No2Bounce-confirmed catch-alls + No2Bounce-confirmed unknowns; everything else rejected. Addresses with no verdict from either vendor increment `unresolved_after_n2b`.

CSV columns are preserved; only `verification_source`, `verification_status`, and `confidence` are added.

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
| `start_verification(file_url, segment_name)` | `{ run_id }` immediately |
| `get_verification_status(run_id)` | status + counts + credits |
| `list_verification_runs(limit?)` | recent compact rows |
| `get_verification_results(run_id)` | signed URLs + stage counts; partial for non-completed runs |
| `resume_verification(run_id)` | resume failed/paused from last completed stage |
| `export_all_sendable(run_ids)` | zip of SENDABLE CSVs → signed URL |

## Resume & partial results

Per-address MillionVerifier results are persisted before No2Bounce starts. Failed or paused runs keep that work; `resume_verification` continues from `stage_completed` (`none` → `mv` → `n2b` → `merge`) and will not re-bill MillionVerifier when `mv_file_id` / address rows already exist.

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
