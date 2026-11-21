# Build brief: Flop Miner Reliability Board (Claude Code + GitHub + Cloudflare)

Give this file plus SPEC.md to Claude Code at the root of an empty GitHub repo.
SPEC.md is the source of truth; this brief says how to build and ship it.

## Prompt to paste into Claude Code

> Read SPEC.md and BUILD-WITH-CLAUDE-CODE.md. Build Phase 0 of the Flop Miner
> Reliability Board exactly as specified: a TypeScript Cloudflare Worker with
> D1, R2, KV and a Queue, Sign-In-With-DID (Ed25519 did:key), signed receipt
> submission (RFC 8785 JCS), aggregation, public JSON feeds and server-rendered
> pages. Follow the repo layout, endpoints, and acceptance tests below. Do not
> invent Flop testnet endpoints; keep them in config. Work in small commits and
> run tests after each step.

## Stack
- Cloudflare Workers (TypeScript, ES modules), Wrangler 3+/4, `nodejs_compat` flag.
- D1 (SQLite) for challenges, sessions, receipts, bindings, stats, rate limits.
- R2 for raw envelopes and public snapshots/feeds; KV only as a hot cache.
- Queues for on-chain verification retries; a daily cron re-queues stale `pending_verification`.
- Libraries: `@noble/ed25519` (or `@noble/curves`), `@noble/hashes`, `bs58`/multibase for did:key,
  `canonicalize` (RFC 8785), `hono` (router), `jose` (JWT). Tests: `vitest` + `@cloudflare/vitest-pool-workers`.

## Repo layout
```
src/index.ts            router (hono), cron + queue handlers
src/auth/               challenge, verify signature, sessions (JWT, httpOnly cookie)
src/did/                did:key parse (z6Mk… → Ed25519 pubkey), verify
src/receipts/           JCS canonicalize, schema validation, submit, dedupe
src/verify/             chain verifier interface; devnet impl; mock (only if ALLOW_MOCK_VERIFIER=true)
src/stats/              aggregation, miners feed, per-miner feed
src/pages/              server-rendered HTML: table, miner detail, methodology, connect
migrations/0001_init.sql
scripts/seed.ts         SAMPLE — NOT LIVE DATA rows
scripts/agent-cli.ts    headless sign-in + submit, reads FLOP_DID_PRIVATE_KEY from env only
test/                   unit + integration
wrangler.toml
.github/workflows/ci.yml, deploy.yml
```

## Endpoints (see SPEC.md §3, §6, §7)
- `POST /v1/auth/challenge` → nonce message bound to domain/uri, expiry, one-time.
- `POST /v1/auth/verify` → {did, signature} → JWT (short-lived) + cookie.
- `POST /v1/receipts` (auth required) → signed receipt envelope; 201 counted/verified, 202 pending, 4xx reasons.
- `POST /v1/bindings` (optional) → sr25519 wallet ↔ DID binding.
- `GET /feeds/miners.json`, `GET /feeds/miners/:id.json`, `GET /feeds/meta.json` (served from R2/KV, cacheable).
- Pages: `/`, `/miner/:id`, `/methodology`, `/connect`.

## Rules that must hold
- Only valid DID signatures are accepted: session sign-in AND per-receipt signature over JCS bytes.
- Nonces single-use, expire (≤5 min), domain-bound; replay rejected.
- Self-dealing (buyer == miner, or bound-wallet match) never counts.
- Rate limits per DID and per IP (D1 counters; KV is not for counters — 1k writes/day on Free).
- Buyer DIDs are redacted in public feeds.
- Mock verifier only when `ALLOW_MOCK_VERIFIER=true`; it must be false in production.
- Sample data shows a visible "SAMPLE — NOT LIVE DATA" banner until a real counted receipt exists.
- Never commit secrets. The Worker never holds any user private key.

## Acceptance tests (minimum)
1. did:key round-trip: generate Ed25519 key, derive did:key, verify signature.
2. Challenge → verify → JWT happy path; expired nonce, reused nonce, wrong domain all fail.
3. Receipt with valid signature accepted; tampered field (JCS bytes differ) rejected.
4. Duplicate receipt id rejected; self-dealing receipt stored but not counted.
5. Rate limit triggers 429.
6. Aggregation produces correct success rate / latency per miner; feeds redact buyers.
7. Mock verifier refused when flag absent.

## Cloudflare setup (one time, from your laptop)
```
npm i -g wrangler && wrangler login
wrangler d1 create flop-board
wrangler r2 bucket create flop-board
wrangler kv namespace create CACHE
wrangler queues create flop-board-verify
# paste the returned IDs into wrangler.toml
wrangler d1 migrations apply flop-board --remote
wrangler secret put SESSION_SIGNING_KEY   # e.g. openssl rand -base64 48
npm run seed -- --remote                  # optional sample data, labeled
wrangler deploy                           # → https://<name>.<subdomain>.workers.dev
```

## GitHub CI/CD
- `ci.yml`: on PR/push → `npm ci`, typecheck, `vitest`.
- `deploy.yml`: on push to `main` → `npm ci`, tests, `wrangler d1 migrations apply --remote`, `wrangler deploy`
  using `cloudflare/wrangler-action`. Repo secrets: `CLOUDFLARE_API_TOKEN`
  (template "Edit Cloudflare Workers" + D1 Edit + R2 Edit + Queues Edit), `CLOUDFLARE_ACCOUNT_ID`.
- GitHub only holds code (and optional daily snapshot export). It is NOT used for ingest.

## Cloudflare account
Account details are kept out of the repo (Free plan).

## Cost
Free plan covers ~1k receipts/day; ~$0–5/mo at 10k/day; ~$8–20/mo at 100k/day (Workers Paid $5/mo). See SPEC.md §9.

## Still open (decide when testnet is live, 24 Nov 2026 target)
Stats window (all-time vs rolling 7d), production hostname, testnet RPC/explorer URLs,
miner discovery, proof/settlement format and decimal scale (SPEC.md §11).
