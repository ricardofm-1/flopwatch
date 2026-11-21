# Flop Miner Reliability Board

Per-miner reliability for Flop inference, built from DID-signed receipts that are checked on chain.
**Phase 0 skeleton** (SPEC.md §10). This is not an official Flop ranking.

The stack is one Cloudflare Worker (TypeScript, Hono). It uses:

- **D1** for challenges, receipts, bindings, stats and rate limits
- **R2** for raw envelopes and daily public snapshots
- **Queues** for on-chain verification retries
- **KV**, bound but used only as an optional cache. Feeds are edge-cached with the Cache API instead, so KV's Free tier of 1k writes/day is never touched per receipt.

## Quick start (local)

```sh
npm ci
cp .dev.vars.example .dev.vars        # set SESSION_SIGNING_KEY; the mock verifier is enabled locally only
npm run migrate:local
npm run seed                          # SAMPLE — NOT LIVE DATA rows
npm run dev                           # http://localhost:8787
npm test                              # vitest inside workerd
```

Headless agent flow (the key is read from env only and never leaves the machine):

```sh
npx tsx scripts/agent-cli.ts keygen                  # once; store the secret yourself
export FLOP_DID_PRIVATE_KEY=… FLOP_BOARD_URL=http://localhost:8787
npx tsx scripts/agent-cli.ts submit receipt.json     # fills did/nonce/submittedAt, strips `reply`, signs, logs in, posts
npx tsx scripts/agent-cli.ts flush                   # retry anything kept in ./.flop-outbox/
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST/GET | `/v1/auth/challenge` | One-time nonce, bound to domain and URI, expires in 5 min. Returns `{ challenge, signingInput }` (the JCS string to sign). |
| POST | `/v1/auth/verify` | `{ did, challenge, signature }` → `{ token }` + HttpOnly cookie (30 min) |
| GET | `/v1/auth/session` · POST `/v1/auth/logout` | Logout revokes the token's `jti`. |
| POST | `/v1/receipts` | Bearer or cookie. `{ payload, signature }`. **201** decided (counted or stored-not-counted), **202** pending chain verification, 400/401/403/409/429 with an `error` code. |
| GET | `/v1/receipts/:id` | Public metadata. Buyer and DID are redacted. |
| POST | `/v1/bindings` | Optional DID ↔ SS58 binding. sr25519 wallet signature plus Ed25519 DID signature over the same JCS payload. |
| GET | `/feeds/miners.json`, `/feeds/miners/:ss58.json`, `/feeds/meta.json`, `/v1/miners` | Edge-cached for 60 s. `?network=testnet\|devnet` |
| GET | `/data/miners.json`, `/data/index.json`, `/data/snapshots/YYYY-MM-DD/{miners.json,receipts.ndjson}` | Daily R2 snapshots |

Pages: `/`, `/miner/:ss58`, `/methodology`, `/connect`. The board, miner and methodology pages are server-rendered and work with JavaScript off. `/connect` needs JavaScript; agents use the API directly.

### Signing

- Receipt id = `sha256(JCS(payload))`.
- Signatures are Ed25519 over the UTF-8 bytes of the RFC 8785 canonical JSON, encoded as base64url.
- The DID must be a `did:key` with multicodec `0xed01`.

## Rules enforced

- **Every receipt is signed.** It needs a session sign-in *and* a signature over its JCS bytes. `payload.did` must equal the session DID.
- **Nonces are single-use and bound to this site's domain.** They expire in 5 minutes or less, and they are burned with an atomic `UPDATE … WHERE used_at IS NULL`.
- **Self-dealing never counts.** This covers buyer = miner, a submitter DID bound to the miner wallet, and buyer and miner bound to the same DID. Such receipts are stored with an exclusion reason.
- **Duplicates are rejected.** A repeated receipt, nonce, or `(network, settlementTx)` returns 409.
- **Rate limits.** Each DID and each IP gets 30/hour and 200/day, using D1 fixed-window counters. Over the limit returns 429 with `Retry-After`.
- **Only verified receipts count.** A row counts only after its chain verification passes. If the RPC is down, the receipt stays `pending_verification`. It is retried through the queue with backoff, and a daily cron re-queues it (Free-tier queue retention is 24 h). It gives up after `VERIFY_MAX_ATTEMPTS` tries.
- **The mock verifier is locked down.**
  - It runs only when `ALLOW_MOCK_VERIFIER=true`. Otherwise submit returns 503.
  - `deploy.yml` refuses to ship with it enabled.
  - Receipts the mock verifier passes never flip the banner to LIVE.
- **The SAMPLE banner stays until real data exists.** It shows until a counted, really-verified testnet receipt exists. After that, sample rows disappear from the aggregates.
- **No secrets are stored.** There are no prompts, outputs, raw URLs or private keys. Feeds never show the buyer wallet or the submitter DID.

## Deploy (when approved)

SPEC.md says not to deploy until Ricardo approves the stack and a domain. When ready:

```sh
wrangler login
wrangler d1 create flop-board                 # paste database_id into wrangler.toml
wrangler kv namespace create CACHE            # paste id into wrangler.toml
wrangler r2 bucket create flop-board
wrangler queues create flop-board-verify
wrangler d1 migrations apply flop-board --remote
wrangler secret put SESSION_SIGNING_KEY       # openssl rand -base64 48
npm run seed -- --remote                      # optional, labelled sample data
wrangler deploy
```

Set `SITE_ORIGIN` once a domain exists. If it is empty, challenges bind to the request origin, which is safe on Cloudflare because it routes by host.

GitHub Actions:

- `ci.yml` typechecks and tests every PR.
- `deploy.yml` runs tests, migrations and the deploy on `main`.
- It needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Deliberately not guessed (SPEC §11)

These stay as config or stubs until testnet publishes them:

- `FLOP_RPC_URL_TESTNET` and the explorer URL templates are empty.
- `RpcVerifier` handles both networks:
  - On devnet it checks that `settlementTx` is included in the claimed block, using lean JSON-RPC and blake2b-256.
  - On testnet it returns `unavailable` until `matchProofFields` is written against the published ComputeChannel / MeteringVerifier format, so nothing on testnet counts without a full check.
  - Channel-only receipts (no settlement tx) wait for the same work.
- Also still open:
  - the default stats window (the UI defaults to all-time, with 7d/30d filters)
  - the decimal scale for FLOP amounts (medians use JS numbers)
  - miner discovery
  - an official DID ↔ wallet binding
