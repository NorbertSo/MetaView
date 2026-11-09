# Trading 2.2 (MetaView)

Autonomous AI trading agents on MetaTrader 5 demo accounts (Admirals via MetaApi), with a password-protected dashboard at **trading.v5v.pl**.

## Architecture

```
Coolify (Hetzner/VPS)                      Cloud
┌──────────────────────────┐   HTTPS   ┌──────────────────────┐
│ web   (Next.js, :3000)   │──────────▶│ Supabase Postgres    │  schema `trading`
│ worker (Node, no port)   │──────────▶│ (session pooler 5432)│  (not exposed via Data API)
└──────────┬───────────────┘           └──────────────────────┘
           │ SDK / RPC
           ▼
   MetaApi cloud ──▶ MT5 terminal ──▶ Admirals demo
   LLM APIs (Anthropic, MiniMax, OpenRouter, any OpenAI-compatible)
   Telegram, ForexFactory calendar, CFTC COT
```

* **web** — dashboard. Reads Postgres directly, writes configuration, enqueues commands. It never calls MetaApi or model APIs and holds only the **public** key: it can encrypt secrets but never read them.
* **worker** — the only process talking to the broker and to models: schedulers, agent runs, risk gates, execution, position sync and reconciliation, kill switch, analyst briefs, trade reviews, data fetchers, Telegram. Holds the **private** key. Runs DB migrations on start (advisory-locked).
* **packages/core** — pure logic shared by both: risk gates and sizing, model output schema, criteria evaluation, sealed-box crypto, LLM pricing.
* **packages/db** — SQL migrations + runner. Invariants (immutability, attribution, 7-day delay for criteria/commitments) are enforced by triggers, not just by the UI.

### Key guarantees
* **Agent = strategy version × model × account**, frozen after activation (DB trigger). Every decision, order and trade carries this attribution; decisions of one agent cannot reference another agent's run or trade. Positions are attributed by per-agent `magic` and verified against our `clientId`.
* **Risk is enforced in code** before every order: mandatory SL on the correct side, SL may only tighten, min R:R, spread vs 7-day median, event blackout, max positions, no duplicates, daily loss, drawdown, account and per-currency open risk, sizing from the agent's own virtual equity. Real-money accounts are blocked (detected from the broker, not trusted from config).
* **Append-only history**: decisions (content), position events, manual overrides, briefs, criteria and commitments cannot be edited or deleted.
* **Your interventions are data**: pausing, closing, changing limits or criteria are logged with reason and equity at that moment.

## Data intake for external producers
`POST /api/ingest/{news|economic_events|market_briefs|journal}` with `Authorization: Bearer tvi_…` (per-source tokens created in *Ustawienia → Źródła danych*, only SHA-256 stored, scoped per feed) and optional `Idempotency-Key`. Payload formats are shown in the dashboard.

## Environment
| Variable | Service | Notes |
| --- | --- | --- |
| `DATABASE_URL` | both | Supabase **session pooler** URI (port 5432) — required for LISTEN/NOTIFY and advisory locks |
| `SECRETS_PUBLIC_KEY` | web | from `pnpm keygen` |
| `SECRETS_PRIVATE_KEY` | worker | from `pnpm keygen` — never give it to web |
| `SESSION_SECRET` | web | ≥ 32 random chars |
| `DASHBOARD_PASSWORD_HASH` | web | `node scripts/hash-password.mjs '<password>'` |
| `PUBLIC_URL` | web | `https://trading.v5v.pl` |
| `LOG_LEVEL` | worker | default `info` |

## Development
```
pnpm install
pnpm --filter @tv/core test          # unit tests (risk, sizing, crypto, schema, criteria)
./scripts/test-db.sh                  # migrations + DB invariant tests on local Postgres
pnpm --filter @tv/worker typecheck && pnpm --filter @tv/web typecheck
```

## Deployment
Coolify, Docker Compose build pack, `docker-compose.yml` at repo root (targets `web` and `worker` in one `Dockerfile`). Domain `trading.v5v.pl` → service `web`, port 3000.
