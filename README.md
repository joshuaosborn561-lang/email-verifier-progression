# VerifyFall — Email Verification Waterfall

Node.js/Express dashboard + MCP server that runs an email verification waterfall:

1. **BillionVerify** (batch of 50) — classify valid / catchall / unknown / invalid  
2. **no2bounce** — re-check only catchall + unknown  
3. **Merge** — BV valid + N2B deliverable → SENDABLE; everything else → REJECTED  

CSV columns are preserved; only `verification_source` and `verification_status` are added.

## Stack

- Express dashboard (static SPA)
- Supabase Postgres + Storage (`verification-uploads`, `verification-results`)
- MCP Streamable HTTP at `POST /mcp`
- Deploy target: Railway

## Environment

| Variable | Description |
|---|---|
| `BILLIONVERIFY_API_KEY` | BillionVerify API key |
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

- BillionVerify: pause if today's usage + projected > **95,000**
- no2bounce: pause if today's usage + projected > **19,000**

Paused runs are logged and left in `paused` status (no service crash).

## API (dashboard)

- `GET /api/health`
- `GET /api/runs`
- `GET /api/runs/:id`
- `POST /api/upload` (multipart `files`)
