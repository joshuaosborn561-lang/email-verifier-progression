# VerifyFall — Email Verification Waterfall

Node.js/Express dashboard + MCP server that runs an email verification waterfall:

1. **MillionVerifier** (bulk file API) — classify `ok` / `catch_all` / `unknown` / `invalid`
2. **no2bounce** — re-check only `catch_all` + `unknown`
3. **Merge** — MV `ok` + N2B Deliverable → sendable (`confidence=confirmed`); N2B `Deliverable/AcceptAll` → sendable (`confidence=unresolved_catchall`); everything else → rejected

CSV columns are preserved; only `verification_source`, `verification_status`, and `confidence` are added.

## Stack

- Express dashboard (static SPA)
- Supabase Postgres + Storage (`verification-uploads`, `verification-results`)
- MCP Streamable HTTP at `POST /mcp`
- Deploy target: Railway

## Environment

| Variable | Description |
|---|---|
| `MILLIONVERIFIER_API_KEY` | MillionVerifier API key |
| `NO2BOUNCE_API_TOKEN` | no2bounce API token |
| `SUPABASE_URL` | `https://azpapwtnrbzywlnxxecz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `PORT` | Optional (default `3000`) |
| `PUBLIC_URL` | Optional public base URL |

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
| `get_verification_results(run_id)` | signed SENDABLE/REJECTED URLs when completed |

## Credit ceilings

- MillionVerifier: pause if projected worst-case usage > **50% of remaining balance**
- no2bounce: pause if today's usage + projected > **19,000**

Paused runs are logged and left in `paused` status (no service crash).

## API (dashboard)

- `GET /api/health`
- `GET /api/runs`
- `GET /api/runs/:id`
- `POST /api/upload` (multipart `files`)
