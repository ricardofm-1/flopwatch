# Flop Miner Reliability Board — Functional and Technical Spec

**Version:** 2 — 20 Nov 2026 (Europe/Lisbon). Replaces v1.
**Status:** draft, spec only. Do not deploy until Ricardo approves the stack and a domain.
**Owner:** Ricardo Martins, operated by FLOP Agent
**Related kit:** `/workspace/flop-testnet-agent/` (align receipt fields with `buy-inference-session.mjs` and `modest-loop.mjs`)
**Agent DID:** `did:key:z6Mkpo9ua8PapGhF8XHA6N4RsA2ZRVKJQz7niHo97PHtofGa`

A public board of per-miner reliability, built from wallet-funded inference purchases. Other agents can connect with a DID signature (the same idea as connecting a wallet to a DeFi app), then submit signed receipts. The backend verifies each proof on chain before a row counts. Technocore and X posts only link here.

---

## 1. Purpose and non-goals

**Purpose.** Publish per-miner success rate, settlement rate, latency p50/p95, price per session and per token (when token counts exist), model(s) served, last seen, and sample size. Every counted row links to an on-chain proof. A stable JSON feed lets agents query the data without scraping HTML.

**Non-goals (v2).** No GitHub Issues or Actions as the ingest path. No visitor accounts or passwords. No storage of prompts, model outputs, wallet mnemonics, or the DID private key. No auto-posts to X or Technocore. This is *observed, verified receipts*, not an official Flop ranking.

Gateway-broker purchases (`api.flop.network`) stay out of the default table. They spend broker funds, often hide the miner, and are not the airdrop path.

---

## 2. v1 rejected alternative (kept for the record)

v1 proposed a static GitHub Pages site with no database: agents would open a signed GitHub Issue (or PR), and Actions would verify and commit NDJSON. That keeps cost at €0 and is fine for *our* few receipts a day. It will not scale to thousands of agents or submissions — Actions minutes, issue-rate limits, serial workflows, and a git-as-database log are the wrong shape. **v1 is rejected as the submission path.** GitHub is now used only for source code and an optional daily public snapshot export.

---

## 3. Authentication: Sign-In-With-DID (like connecting a wallet)

Any valid Ed25519 `did:key` may connect. There is no allowlist for login. A short-lived session *enables* submit; it is not enough on its own for a receipt to be counted (see §4).

### 3.1 Challenge / response

1. Client calls `GET /v1/auth/challenge`. The server stores a one-time nonce and returns a challenge object:
   - `specVersion`, `kind: "flop.siwd.challenge"`
   - `domain` and `uri` (bound to this site, so a signature cannot be replayed on another origin)
   - `nonce` (128-bit hex), `issuedAt`, `expiresAt` (short, e.g. 5–10 minutes)
   - `statement` (human-readable: sign in to submit miner receipts)
2. The client canonicalizes the challenge with RFC 8785 JCS and signs those UTF-8 bytes with the DID's Ed25519 key.
3. Client calls `POST /v1/auth/verify` with `{ did, challenge, signature }`.
4. The server checks: challenge exists and is unexpired and unused; `domain`/`uri` match this deployment; `did` is a `did:key` with Ed25519 multicodec `0xed01`; the signature verifies against the public key extracted from the DID. The nonce is then burned.
5. The server issues a **short-lived session token** (15–60 minutes): a signed JWT (HMAC or Ed25519 with a *server* session key stored as a Worker secret). Claims: `did`, `iat`, `exp`, `jti`.

**Browser flow (humans).** A "Connect" button requests the challenge. If a DID wallet / extension is present, it signs and the site sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. If no extension exists — likely on day one — the UI shows the challenge and a paste-signature field, plus a one-line CLI (`sign the challenge, print only the signature`). Submit stays disabled until a session is established.

**Headless API flow (agents).** The same two HTTP calls. The agent signs locally with `FLOP_DID_PRIVATE_KEY` (never sent to the server). It then sends `Authorization: Bearer <jwt>` on submit. Our day-one kit will use this path after each `runDirectSession` attempt.

Rate-limit challenges per DID and per IP so the nonce table cannot be flooded.

### 3.2 Why every receipt is still signed, even inside a session

The session token only proves that *someone currently holding a bearer token* is acting as that DID. Tokens can leak (logs, XSS, a stolen cookie, a forwarded header) and would otherwise let an attacker post arbitrary receipts until expiry.

Each receipt remains a DID-signed envelope over the payload itself (miner, channel, amounts, hashes). That gives non-repudiation: the DID attested to those facts, and anyone can verify the signature later from a public snapshot without trusting our server. A stolen session cannot mint a lasting, independently verifiable receipt without the DID key. Session auth is a gate and an anti-spam control; the receipt signature is the evidence.

---

## 4. Open submission and sybil / spam controls

Login is open to any valid `did:key`. A receipt is **accepted into storage** only if the session DID matches `payload.did` and the receipt signature verifies. It **counts in public aggregates** only if it also passes on-chain verification and the anti-abuse rules below.

| Control | Rule |
| --- | --- |
| Rate limits | Per DID and per IP, e.g. 30 submits / hour and 200 / UTC day (enough for real agents; not a flood). Return `429`. |
| On-chain proof required to count | Referenced channel / settlement extrinsic exists on the public RPC; `buyer`, `miner`, `model` (or model hash) and status match the chain. Until it verifies, status is `pending_verification` and it is hidden from rankings. If RPC is down, do not count it; queue a retry. |
| DID ↔ wallet binding (optional, then recommended) | The paying SS58 wallet signs a JCS message that binds itself to the DID (sr25519 signature). Stored after verification. Phase 2 can require this before a receipt counts, unless Flop publishes an official binding we should reuse. |
| Self-dealing | Hard exclude `buyer === miner`. Later heuristics: denylist of addresses under common control, and obvious clusters (a buyer that only ever pays one miner it funds). Excluded receipts stay out of aggregates and are marked why. |
| Dedup / replay | Unique `nonce` on the receipt; reject duplicate `(network, channelId, settlementTx)`. Receipt `submittedAt` freshness window as in §6. |
| Privacy | Prompts, outputs, mnemonics, DID private keys, and raw miner URLs are never stored — hashes only. |

Gateway sessions never count in the default table.

---

## 5. Platform choice (verified 20 Nov 2026)

GitHub is not the backend. The backend must be a real API that can authenticate, write, verify on chain, and serve a feed to thousands of agents, at free or near-free cost.

Limits below were read from official pricing/docs pages on 20 Nov 2026 (Europe/Lisbon). Providers can change them; re-check before going paid.

### 5.1 Cloudflare Workers / Pages + D1 + KV + R2 + Queues

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [marketing comparison](https://www.cloudflare.com/plans/developer-platform-pricing/).

**Workers Free ($0):** 100,000 Worker requests / day (resets 00:00 UTC), 10 ms CPU time per invocation, no charge for wall-clock duration or egress. Static asset requests are free and unlimited. 50 subrequests per invocation.

**Workers Paid ($5 USD / month):** 10 million requests / month included, then $0.30 / million; 30 million CPU-ms / month included, then $0.02 / million CPU-ms; default 30 s CPU per invocation, max 5 minutes (Cron / Queue consumers can use the higher cap). Still no egress charge.

**D1:** Free — 5 million rows read / day, 100,000 rows written / day, 5 GB storage, 10 databases. Paid — 25 billion rows read / month included then $0.001 / million; 50 million rows written / month included then $1.00 / million; 5 GB storage included then $0.75 / GB-month. Hitting a Free daily cap returns errors until the next UTC day; upgrade removes the cap within minutes.

**KV:** Free — 100,000 reads / day, **1,000 writes / deletes / lists / day**, 1 GB. Paid — 10 million reads / month then $0.50 / million; 1 million writes / month then $5.00 / million; 1 GB included then $0.50 / GB-month. Too few Free writes for a per-receipt store; use KV only as a small hot cache (aggregates, RPC metadata).

**R2 Standard free tier (monthly):** 10 GB-month storage, 1 million Class A (writes/lists) / month, 10 million Class B (reads) / month, **egress free**. Then $0.015 / GB-month, $4.50 / million Class A, $0.36 / million Class B.

**Queues: available on Workers Free**, not paid-only. Free — 10,000 operations / day, 10,000 queues / account, **24-hour retention (fixed)**. Paid — 1 million operations / month included then $0.40 / million; retention up to 14 days. An operation is counted per 64 KB chunk written, read, or deleted; a typical message costs **3 operations** (write + read + delete), so Free is about **3,300 messages / day**. Retries cost extra reads. Queue consumer CPU follows the Workers plan (10 ms on Free — tight for heavy decode; ample on Paid).

**Pages:** Free plan 500 builds / month, 20,000 files / site, 25 MiB per file. Pages Functions share the Workers request and CPU quota.

### 5.2 Alternatives considered

**Vercel + Supabase or Turso.** [Vercel pricing](https://vercel.com/pricing) / [docs](https://vercel.com/docs/pricing): Hobby $0 includes 1 million Function invocations / month, 4 hours Active CPU, 1 million CDN requests, 100 GB Fast Data Transfer. Pro starts at $20 / month. Functions are a good API host, but there is no first-party queue + SQLite + object store in one account. [Supabase Free](https://supabase.com/pricing) is $0 with 500 MB database, 5 GB egress, 1 GB file storage — and **Free projects are paused after 1 week of inactivity**, which is unacceptable for a public board. [Turso Free](https://turso.tech/pricing.md) is stronger as a DB (100 databases, 5 GB storage, 500 million rows read / month, 10 million rows written / month) and does not sleep, but it is a second vendor, with no included queue or object store (those stay on Vercel Blob: Hobby 1 GB and tight operation caps). Two bills, two dashboards, and a $20 jump (Vercel Pro) or $25 (Supabase Pro) if Hobby/Free is outgrown — worse than Cloudflare's $5 step.

**Netlify.** [Pricing](https://www.netlify.com/pricing/) is credit-based: Free includes 300 credits ("forever"). Production deploys cost 15 credits each, compute 10 credits / GB-hour, bandwidth 20 credits / GB, web requests 2 credits / 10k. A busy API burns the pack quickly; Personal is $9 / month. Not a predictable home for agent submit traffic.

**Deno Deploy + Deno KV.** [Pricing](https://deno.com/deploy/pricing): Free is $0 with 1 million requests / month, 20 GiB egress, 10 hours Active CPU, 1 GiB KV, 1 million KV read units / month, 500,000 KV write units / month. Pro is $20 / month (5 million requests, then $2 / million). Genuinely simple, and Free covers a low-traffic board. It is tighter at scale (1 million requests / month ≈ 33k / day; 500k KV writes / month is the first cap) and the paid jump is $20, not $5. No built-in queue product comparable to Cloudflare Queues; no R2-style egress-free object dump.

### 5.3 Recommendation

**Cloudflare: Pages (or Workers static assets) + Workers + D1 + R2, with Queues for async on-chain retries, and KV only as a small cache.**

One account, one deploy, no egress fees, a real SQL database, object storage for the public log, and a queue. Free is enough for the skeleton and for roughly a few thousand receipts/day if we serve the public feed as static/R2 files and do not write KV per receipt. When volume, queue depth, or the 10 ms CPU cap gets in the way, **Workers Paid at $5/month** is the planned upgrade — not a surprise.

GitHub holds the source. A daily cron can export NDJSON/JSON snapshots to a public R2 prefix (and optionally commit a copy to a `snapshots/` branch) for auditability. That export is not on the submit path.

---

## 6. Data model and signed receipt

### 6.1 Envelope (unchanged in spirit from v1)

```json
{
  "payload": { "...receipt fields..." },
  "signature": "<base64url Ed25519 signature of JCS(payload)>"
}
```

`payload.did` is the signer. Verify by extracting the Ed25519 public key from the `did:key`. Reject if it does not match the session DID.

**Payload v1 fields** (aligned with the kit's `network`, `miner`, `model`, `maxFlop`, `channelId`, `status`, `settlement` / `settlementTx`):

| Field | Required | Notes |
| --- | --- | --- |
| `specVersion` | yes | `1` |
| `kind` | yes | `"flop.miner-receipt"` |
| `network` | yes | `"testnet"` or `"devnet"`; default views are testnet only |
| `did` | yes | Submitter `did:key:…` |
| `submittedAt` | yes | ISO-8601 UTC |
| `nonce` | yes | 128-bit hex, unique among receipts |
| `buyer` | yes | SS58 that paid |
| `miner` | yes | Miner SS58 |
| `model` | yes | Registered model id |
| `modelHash` | no | On-chain weight hash when known |
| `channelId` | if settled path | From `runDirectSession` |
| `status` | yes | `settled` \| `failed` \| `timeout` \| `challenged` \| `pending` \| `rejected` |
| `ok` | yes | `true` only if inference returned **and** the session settled |
| `settlementTx` | no | Extrinsic hash |
| `blockNumber` | no | |
| `maxFlop` | yes | Decimal string, kit encoding (`"0.01"`) |
| `paidFlop` | no | Actual paid amount when the SDK/chain expose it; never substitute the cap |
| `promptTokens`, `completionTokens` | no | |
| `latencyMs` | when attempted | Wall time to response or failure |
| `startedAt`, `finishedAt` | startedAt yes | ISO-8601 UTC |
| `errorClass` | no | Coarse: `timeout`, `rpc`, `miner-unreachable`, `settlement`, `proof` |
| `promptHash` | yes | `sha256:` + hex of the prompt bytes — not the prompt |
| `outputHash` | no | Same for output |
| `endpointHash` | no | SHA-256 of the miner URL; never the raw URL |

Failed and timed-out attempts are valid submissions; they are the reliability signal. Unknown SDK fields stay `null`. Do not invent amounts or explorer links.

Receipt freshness: reject if `submittedAt` is more than 5 minutes in the future, or more than 7 days after `finishedAt` / `startedAt`.

### 6.2 Storage layout (no Git ingest)

**D1 (operational database).** Indexed tables, for example: `challenges` (nonce, expiry, used), `sessions_revoked` (optional `jti` denylist; JWTs are otherwise stateless), `bindings` (did, wallet, sr25519 proof, network), `receipts` (payload fields, sig, verification status, exclusion reason), `miner_stats` (materialized 7d / 30d / all), `rate_limits`. Keep SQL indexes on `did`, `miner`, `channelId`, `settlementTx`, `nonce`, `status`.

**R2 (immutable log and public feed).** One object per accepted envelope under `receipts/YYYY/MM/<id>.json`, plus daily `snapshots/YYYY-MM-DD/receipts.ndjson`, `miners.json`, and `index.json`. Public, cacheable, no egress fee. This is the auditor's copy.

**KV (tiny, write-sparingly).** Cached `miners.json`, cached Substrate metadata / storage-key prefixes. Not the receipt store (Free = 1,000 writes/day).

**GitHub (optional).** Daily snapshot export only. Never the live submit path.

Retention: keep testnet receipts for the testnet window (~90 days) plus 90 days after snapshot. Raw bodies live in R2; D1 can drop or archive old rows if storage becomes tight (Free 5 GB is many millions of index rows).

Schema versioning: `specVersion` on every payload; aggregates carry `schemaVersion`. A v2 adds columns or a new prefix; do not silently rewrite old envelopes.

---

## 7. Functional spec

Times are stored in UTC and shown in Europe/Lisbon with a zone label. A banner states **SAMPLE DATA** or **LIVE TESTNET DATA**, the network, and when aggregates were last built.

1. **Home — miner table.** One row per miner (and per model if needed): truncated SS58 with copy and explorer link, model, `n`, success rate, settlement rate, latency p50/p95, median FLOP / settled session, median FLOP / token (or "n/a"), last seen. Warn when `n < 5`. Filters: model, window (7d / 30d / all), minimum `n`. Sort any column. Pre-render the default table in HTML so it works with JavaScript off.
2. **Miner detail.** Same stats for each window, chronological receipt index (no prompts), channel / tx links, exclusion notes.
3. **Connect + submit (browser).** Connect via §3. After session, a submit form (paste or upload one signed envelope) becomes enabled. Agents should use the API, not the form.
4. **Methodology.** What counts, gateway exclusion, self-dealing, signatures, on-chain checks, rate limits, "not official Flop."
5. **JSON / API** (stable paths):
   - `POST /v1/auth/challenge`, `POST /v1/auth/verify` (challenge may be GET)
   - `POST /v1/receipts` — session required; returns `202` if queued for chain verify, `201` if already counted, `401`/`403`/`409`/`429` as appropriate
   - `GET /v1/receipts/:id` — public metadata (no secrets)
   - `POST /v1/bindings` — optional DID ↔ wallet binding
   - Public feed, preferably static/R2 (does not burn Worker quota): `/data/miners.json`, `/data/miners/<ss58>.json`, `/data/index.json`, daily NDJSON snapshots
   - `GET /v1/miners` as a thin alias if needed

**Aggregation** (per network, miner, model, and window), from receipts with `verification = passed` and not excluded:

- Success rate = count(`ok` and `status = settled`) / count(`status != pending` and not `pending_verification`).
- Settlement rate = `settled` / (`settled` + `challenged` + settlement `failed` + `timeout` after accept).
- Latency p50/p95 from `latencyMs` on attempts that have one (including failed calls).
- Price/session = median `paidFlop` on settled receipts that have it — never treat `maxFlop` as a price.
- Price/token = median `paidFlop / (promptTokens + completionTokens)` when both exist.
- Last seen = max `finishedAt` or `startedAt`.

Recompute on ingest (upsert `miner_stats`) and again on a daily cron. Do not hand-edit aggregates.

**Agent auto-submit.** After each kit purchase (success or failure), build a receipt *without* the 200-character `reply` slice the current session file may contain, sign it, obtain a session (or reuse one), `POST /v1/receipts`. If submit fails, keep the local receipt and retry; do not break the modest-loop ledger. Never log the DID key.

---

## 8. Technical plan

### 8.1 Architecture

```
Browser / agent
  → Workers API   /v1/auth/*  /v1/receipts  /v1/bindings
      → D1        challenges, receipts, bindings, stats, rate limits
      → Queue     on-chain verification retries (and optional always-async verify)
      → R2        raw envelopes + public snapshots
      → KV        hot miners.json, RPC metadata (rare writes)
      → public Flop HTTP RPC  (verify channel / settlement; cache keys)
  → Pages / R2    static site + /data/* feed (no Worker request cost)
GitHub            source; optional daily snapshot commit
```

Stack: TypeScript Workers, a small static HTML/CSS/JS front end (no heavy SPA required), D1 migrations in-repo. Pin dependencies and Action/Wrangler versions. Official testnet endpoints go in config when published; until then, do not invent them.

### 8.2 On-chain verification in the Worker

Use the public **HTTP** RPC (devnet today: `https://rpc.devnet.flop.network`; testnet from official docs only). Prefer lean `state_getStorage` / `chain_getBlock` JSON-RPC and precomputed storage key prefixes over booting full `@polkadot/api` metadata on every request — that is the realistic way to stay inside Free's 10 ms CPU, and it is still a good idea on Paid.

Confirm, once the testnet proof format is known: the `channelId` or settlement extrinsic exists, `buyer` and `miner` match, model / hash match if exposed, and status is consistent with the payload. Self-dealing (`buyer === miner`) fails the "counts" rule even if the chain tx is real.

**Sync vs queue.** Try a short inline verify first. If the RPC is slow, errors, or the work needs more CPU, write the receipt as `pending_verification`, return `202`, and enqueue a job. The consumer retries with backoff. On Free, queue capacity is ~3,300 messages/day and consumer CPU is 10 ms, so prefer inline success and use the queue as a retry path. On Paid, the queue can be the default and consumers can use a higher CPU cap. If a job expires on Free (24 h retention), a daily cron must scan and re-queue leftover `pending_verification` rows.

Cache chain metadata and recent verification results briefly in KV so burst traffic does not hammer the RPC (50 subrequests/invocation on Free is enough for a single receipt check plus D1/R2).

### 8.3 Key management

| Secret | Where it lives | Where it must not live |
| --- | --- | --- |
| `FLOP_DID_PRIVATE_KEY` | Agent box env, used only to sign challenges and receipts | Repo, Workers, Wrangler secrets, logs, issue bodies, chats |
| Wallet mnemonics | Existing kit files, mode 600 | Same as above |
| `SESSION_SIGNING_KEY` | Cloudflare Worker secret (server-issued JWTs only) | Client, git, snapshots |
| Optional `gh` token | Only if we export snapshots to GitHub; `contents` on the snapshots branch | The Worker, if not needed |

Verification of user signatures needs no private key: `did:key` is public. The session key is ours, not a user DID key, and can be rotated (all sessions drop).

### 8.4 Threat model

| Threat | Mitigation |
| --- | --- |
| Forged receipt | Per-receipt Ed25519 over JCS; session DID must match `payload.did` |
| Stolen session token | Short TTL; HttpOnly cookie for browsers; per-receipt signature still required to count as evidence; optional `jti` revoke |
| Challenge replay / phishing | One-time nonce, expiry, `domain`/`uri` binding |
| Spam / Sybil | Rate limits; only on-chain settled (or honestly failed, if the failed attempt itself is on chain) sessions count; optional wallet binding; self-dealing rules |
| Invented sessions | No count without RPC confirmation |
| Self-scoring | `buyer !== miner`; denylist / cluster heuristics |
| Tiny samples presented as truth | Show `n`, warn when `n < 5` |
| Prompt / output leak | Hashes only; kit must strip `reply` before submit |
| Server key leak | Rotate `SESSION_SIGNING_KEY`; user DID keys are not on the server |
| RPC outage or lie | Official public RPC; no count on failed checks; queue + cron retry; optional explorer cross-check later |
| Quota exhaustion (Free) | Serve feeds from R2/static; spend cap / upgrade path to Workers Paid; fail soft with `429`/`503` |

---

## 9. Capacity and cost

Assumptions (stated so they can be revised): about **3 Worker invocations per receipt** (submit, plus a queue consumer when used; auth is amortized across a session). Public table and JSON feed served from **R2 or static assets** (Free Worker quota is not spent on reads). About **6 D1 row-writes** per receipt (insert, indexes, stats upsert, rate counter). Receipt body ≈ 2 KB, stored in R2 (per-object or in a daily NDJSON flush). Queue: 3 operations per async verify. Prices are **USD**, from the official pages cited in §5.1, as of 20 Nov 2026. EU accounts may also see VAT; that is not included below.

**Expected volume vs Free caps**

| Scale | Receipts | Workers req / day (approx.) | D1 writes / day | Queue ops / day if every receipt is queued | Fits Workers Free? |
| --- | --- | --- | --- | --- | --- |
| Low | 1,000 / day | ~3,000 + browse | ~6,000 | ~3,000 | **Yes, comfortably** |
| Medium | 10,000 / day | ~30,000 + browse | ~60,000 | ~30,000 (over 10,000 Free cap) | **Edge.** D1 and Workers still fit if the feed is static. Queues do **not** if every receipt is queued; use inline verify + queue only on retry, or upgrade. 10 ms CPU is the other risk. |
| High | 100,000 / day | ~300,000 (over 100,000/day Free) | ~600,000 (over 100,000/day Free) | ~300,000 | **No — Workers Paid required.** |

A practical reading: stay on **Free ($0)** through Phase 0 and early live use (our own agent is 3 sessions/day; even a few hundred other agents is usually still Free). Plan to flip **Workers Paid ($5/month)** once we rely on the queue, hit 10 ms CPU, or approach the 100k request or 100k D1-write daily caps (around the 10k receipts/day region).

**Cost table** (steady month, 30 days). Paid figures use included allotments first, then published overages. R2 writes assumed as **daily snapshot flushes** (not 1 Class A per receipt). D1 keeps indexes; raw envelopes live in R2.

| Receipts / day | Plan | Workers | D1 | Queues | R2 | **Est. monthly** |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | Free | well under 100k/day | well under 100k writes/day | under 10k ops/day even if queued | well under 10 GB / 1M Class A | **$0** |
| 10,000 | Free, if inline verify and static feed | under 100k/day | ~60k writes/day (tight but under) | only if most verifies stay inline | fine | **$0**, fragile |
| 10,000 | **Workers Paid (recommended at this scale)** | included (9M req / mo < 10M) | included | included if ≤1M ops/mo; 10k×3×30=0.9M | included | **$5 / mo** |
| 100,000 | Workers Paid | ~9M req / mo if 3 inv/receipt, near the 10M include; extra requests $0.30/M | ~18M writes / mo (under 50M include) | 9M ops ≈ (9−1)×$0.40 = **$3.20** | storage ~18 GB-month after 90 days retained: ~8 GB billable × $0.015 ≈ **$0.12**; Class A negligible if daily flushes | **≈ $8–20 / mo** ($5 + queues + possible request/CPU overage). CPU example: 10 ms × 9M = 90M ms, (90−30)×$0.02 = $1.20. |

Set a Cloudflare spending limit (available on Paid) so a bug cannot run away. 100k receipts/day is a very optimistic ceiling for early testnet; $5–20/month at that level is still cheap.

---

## 10. Phased build plan

**Phase 0 — skeleton, before 24 Nov 2026.** Cloudflare project, D1 schema, SIWD auth (browser paste-signature + headless), submit API, sample receipts clearly marked `SAMPLE — NOT LIVE DATA`, static table + methodology + stub feed, verification mocked or pointed at devnet only. No real testnet spend.

**Phase 1 — testnet open (target 24 Nov).** Official RPC/explorer in config. Our agent auto-submits via the headless flow. Real on-chain checks once channel/settlement fields are stable. SAMPLE banner comes down only after at least one counted live receipt. Keep the kit's daily cap and independent-miner rule.

**Phase 2 — open the board.** Announce the connect + submit API (draft for Ricardo). Optional, then recommended, DID ↔ wallet binding. Tighten rate limits if needed. Daily R2 snapshots (and optional GitHub export).

**Phase 3 — optional.** Richer self-dealing heuristics, miner detail charts, and a move to Workers Paid as soon as Free caps or 10 ms CPU become a problem — do not wait for an outage.

---

## 11. Open questions (resolve when testnet is live)

Unchanged in kind from the day-one kit and v1; the skeleton must not guess them.

1. **Miner discovery.** How public miner HTTPS endpoints or a match/directory appear on testnet.
2. **Session proof shape.** Exact `channelId`, settlement extrinsic, events, and explorer deep-links from `@flop-labs/sdk` and ComputeChannel / MeteringVerifier, so the Worker can verify with lean RPC.
3. **Paid amount and token counts.** Whether `runDirectSession` or chain state returns `paidFlop` and token counts. Until then, price/token is "n/a".
4. **Official testnet RPC, explorer, SS58, and launch time on 24 Nov.** Devnet does not count for airdrop.
5. **Official DID ↔ wallet binding**, if Flop publishes one we should reuse instead of (or in addition to) our optional sr25519 binding.
6. **Whether a testnet gateway exposes miner identity** (still excluded from the default table).
7. **Official model identity** (name vs weight hash) and multi-model miners.
8. **Challenge-window length**, so `pending` can age out.
9. **Whether Flop ships an official miner directory** this board should complement, not appear to replace.
10. **Browser DID wallet / extension.** If none exists, the paste-signature + CLI path is the human connect flow until one does.
11. **Domain and Cloudflare account.** Needed before a real `domain`-bound SIWD deployment (a `*.pages.dev` or `*.workers.dev` name can serve Phase 0).

---

## 12. Decision record

| Decision | Choice |
| --- | --- |
| Ingest path | HTTP API, not GitHub Issues / Actions |
| Auth | Sign-In-With-DID challenge/response + short-lived JWT/cookie; browser and headless |
| Receipt evidence | Still a per-receipt DID signature (non-repudiation) |
| Who may connect | Any valid Ed25519 `did:key` |
| What may count | On-chain verified, not self-dealing, under rate limits; optional then recommended wallet binding |
| Backend | Cloudflare Workers + D1 + R2 + Queues; KV as a small cache |
| GitHub | Source + optional daily snapshot export only |
| Cost | $0 on Free until caps; planned upgrade **Workers Paid $5/month**; ~$8–20/month only at very high volume (≈100k receipts/day) |
