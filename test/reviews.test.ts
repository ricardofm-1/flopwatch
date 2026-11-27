import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as sr25519 from "@scure/sr25519";
import { ss58Decode, ss58Encode } from "../src/did/ss58";
import { bytesToHex, hexToBytes, randomHex, utf8 } from "../src/lib/encoding";
import { jcs } from "../src/receipts/jcs";
import { submitReview } from "../src/reviews/submit";
import { computeReviewStats, shrunkMean } from "../src/reviews/aggregate";
import { reviewFromSession } from "../src/reviews/map";
import { validateReviewPayload } from "../src/reviews/schema";
import { HttpError } from "../src/lib/http";
import { channelsStorageKey, KNOWN_GENESIS, RpcVerifier, planckToFlop } from "../src/verify/rpc";
import { getVerifier } from "../src/verify";
import type { Env } from "../src/env";
import { call, envelope, login, makePayload, newKey, randomSs58, submit, uniqueIp, type TestKey } from "./helpers";

// ---------- fixtures ----------

/** A channel id that the mock verifier treats as an ordinary Closed channel (never 0xdead… / 0x0e…). */
const chan = () => `0x1${randomHex(31)}1`;

function makeReview(did: string, over: Record<string, unknown> = {}) {
  return {
    specVersion: 1,
    kind: "flop.miner-review",
    network: "testnet",
    did,
    submittedAt: new Date().toISOString(),
    nonce: randomHex(16),
    buyer: randomSs58(),
    miner: randomSs58(),
    model: "qwen/qwen3-8b",
    channelId: chan(),
    settlementTx: `0x${randomHex(32)}`,
    scores: { quality: 4, latency: 4, cost: 3, delivery: 5 },
    delivered: true,
    ...over,
  };
}

async function bind(did: string, wallet: string, network = "testnet") {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO bindings (did, wallet, network, payload_json, wallet_signature, did_signature, created_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(did, wallet, network, "{}", "00", "00", Date.now()).run();
}

const postReview = (token: string, body: unknown, ip: string) =>
  call("/v1/reviews", { method: "POST", token, ip, body: JSON.stringify(body) });

/** Generous limits for tests that submit many reviews directly (rate limiting has its own test). */
const roomy = (over: Partial<Env> = {}) => ({ ...env, RATE_LIMIT_SUBMIT_HOURLY: "1000", RATE_LIMIT_SUBMIT_DAILY: "1000", ...over }) as Env;

async function direct(key: TestKey, payload: Record<string, unknown>, opts: { env?: Env; verifier?: RpcVerifier; walletSignature?: string; ip?: string } = {}) {
  const e = opts.env ?? roomy();
  const body = { ...envelope(key, payload), ...(opts.walletSignature ? { walletSignature: opts.walletSignature } : {}) };
  return submitReview(e, { sessionDid: key.did, ip: opts.ip ?? uniqueIp(), verifier: opts.verifier ?? getVerifier(e) }, body);
}

async function expectHttpError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err, `expected ${status} ${code}`).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  expect((err as HttpError).code).toBe(code);
}

/** Real-format SCALE encoding of pallet_compute_channel::Channel (layout checked on Devnet + Testnet). */
function encodeChannel(o: { agent: string; miner: string; modelHash?: string; escrowPlanck: bigint; openedAt: number; state: 0 | 1 | 2 | 3 }) {
  const parts: number[] = [];
  const push = (b: Uint8Array) => parts.push(...b);
  const le = (v: bigint, n: number) => { const b = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  push(ss58Decode(o.agent).publicKey);
  push(ss58Decode(o.miner).publicKey);
  push(o.modelHash ? hexToBytes(o.modelHash) : new Uint8Array(32));
  push(new Uint8Array(32)); // measured_root
  push(Uint8Array.of(2)); // precision BF16
  push(new Uint8Array(32)); // enclave_key
  push(new Uint8Array(32)); // agent_key
  push(le(o.escrowPlanck, 16));
  push(new Uint8Array(12)); // sla
  push(new Uint8Array(8)); // nonce
  push(le(BigInt(o.openedAt), 4));
  push(le(BigInt(o.openedAt), 4)); // last_attested_at
  push(Uint8Array.of(o.state));
  if (o.state === 1) push(new Uint8Array(32 + 16 + 4));
  if (o.state === 3) push(new Uint8Array(4));
  push(Uint8Array.of(0, 0)); // transcript_ref None, weights_pin None
  push(new Uint8Array(16)); // locked_compute_consumed
  return `0x${bytesToHex(Uint8Array.from(parts))}`;
}

/** Fake FLOP HTTP RPC serving one channel; `genesis` lets a test impersonate a wrong chain. */
function fakeChain(o: { channelId: string; raw: string | null; openedAtMs?: number; genesis?: string }) {
  const openedHash = `0x${"ab".repeat(32)}`;
  const tsKey = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
  const ms = BigInt(o.openedAtMs ?? Date.now() - 3_600_000);
  const tsLe = `0x${Array.from({ length: 8 }, (_, i) => Number((ms >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("")}`;
  const calls: string[] = [];
  const fetchFn = async (_: RequestInfo, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    let result: unknown = null;
    if (method === "chain_getBlockHash") result = params[0] === 0 ? (o.genesis ?? KNOWN_GENESIS.testnet) : openedHash;
    else if (method === "state_getStorage" && params[0] === channelsStorageKey(o.channelId)) result = o.raw;
    else if (method === "state_getStorage" && params[0] === tsKey) result = tsLe;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  // A distinct URL per fake chain: the verifier memoises a passed genesis check per RPC URL.
  const url = `https://rpc-${randomHex(4)}.example`;
  return { verifier: new RpcVerifier({ testnet: url }, fetchFn, KNOWN_GENESIS), calls };
}

/** A review + a matching on-chain channel served by a fake RPC. */
function onChain(key: TestKey, over: Record<string, unknown> = {}, ch: Partial<{ state: 0 | 1 | 2 | 3; escrowPlanck: bigint; agent: string; miner: string; openedAtMs: number; missing: boolean; genesis: string }> = {}) {
  const p = makeReview(key.did, { maxFlop: "0.05", ...over }) as ReturnType<typeof makeReview> & Record<string, unknown>;
  const raw = ch.missing
    ? null
    : encodeChannel({ agent: ch.agent ?? (p.buyer as string), miner: ch.miner ?? (p.miner as string), escrowPlanck: ch.escrowPlanck ?? 50_000_000_000_000_000n, openedAt: 197004, state: ch.state ?? 2 });
  return { p, ...fakeChain({ channelId: p.channelId as string, raw, openedAtMs: ch.openedAtMs, genesis: ch.genesis }) };
}

// ---------- tests ----------

describe("POST /v1/reviews over HTTP (mock chain)", () => {
  it("1. counts a signed review with a Closed channel and a proven buyer (binding)", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const p = makeReview(key.did);
    await bind(key.did, p.buyer as string);
    const r = await postReview(token, envelope(key, p), ip);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ verification: "passed", counted: true, status: "counted", buyerProof: "binding" });
    expect(r.json.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("2. rejects a bad signature, a DID that isn't the session's, and no session", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const other = newKey();
    const token = await login(key, ip);
    const p = makeReview(key.did);
    await bind(key.did, p.buyer as string);
    const tampered = { ...envelope(key, p), payload: { ...p, scores: { ...p.scores, quality: 1 } } };
    expect((await postReview(token, tampered, ip)).json.error).toBe("invalid_review_signature");
    const r = await postReview(token, envelope(other, makeReview(other.did)), ip);
    expect([r.status, r.json.error]).toEqual([403, "did_mismatch"]);
    expect((await call("/v1/reviews", { method: "POST", ip, body: JSON.stringify(envelope(key, p)) })).status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE did IN (?, ?)").bind(key.did, other.did).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("7. 403 buyer_not_proven without a binding, wallet signature or counted receipt", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const r = await postReview(token, envelope(key, makeReview(key.did)), ip);
    expect([r.status, r.json.error]).toEqual([403, "buyer_not_proven"]);
  });

  it("9/10. one review per channel (any case) and per nonce", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const buyer = randomSs58();
    await bind(key.did, buyer);
    const p = makeReview(key.did, { buyer });
    expect((await postReview(token, envelope(key, p), ip)).status).toBe(201);
    const again = makeReview(key.did, { buyer, channelId: (p.channelId as string).toUpperCase().replace("0X", "0x") });
    expect((await postReview(token, envelope(key, again), ip)).json.error).toBe("duplicate_channel");
    const sameNonce = makeReview(key.did, { buyer, nonce: p.nonce });
    expect((await postReview(token, envelope(key, sameNonce), ip)).json.error).toBe("duplicate_nonce");
  });

  it("11. self-dealing (buyer = miner) is stored, excluded, not counted", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const w = randomSs58();
    await bind(key.did, w);
    const r = await postReview(token, envelope(key, makeReview(key.did, { buyer: w, miner: w })), ip);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ counted: false, excludedReason: "self_dealing:buyer_is_miner" });
  });

  it("buyer proof via a counted receipt for the same channel", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const ch = chan();
    const rp = makePayload(key.did, { channelId: ch, settlementTx: null, blockNumber: null });
    const rec = await submit(token, envelope(key, rp), ip);
    expect(rec.json.counted).toBe(true);
    const p = makeReview(key.did, { buyer: rp.buyer, miner: rp.miner, channelId: ch, flopwatchReceiptId: rec.json.id });
    const r = await postReview(token, envelope(key, p), ip);
    expect(r.json).toMatchObject({ counted: true, buyerProof: "receipt" });
  });
});

describe("review schema (3, 4)", () => {
  const did = newKey().did;
  const errs = (over: Record<string, unknown>) => validateReviewPayload(makeReview(did, over)).errors.join(" | ");
  it("rejects bad scores, categories, notes, forbidden and unknown fields", () => {
    expect(validateReviewPayload(makeReview(did)).ok).toBe(true);
    expect(errs({ scores: undefined })).toMatch(/scores must be an object/);
    expect(errs({ scores: { quality: 6, latency: 4, cost: 3, delivery: 5 } })).toMatch(/scores.quality must be an integer 1–5/);
    expect(errs({ scores: { quality: 0, latency: null, cost: null, delivery: null } })).toMatch(/1–5/);
    expect(errs({ scores: { quality: null, latency: null, cost: null, delivery: null } })).toMatch(/at least one score/);
    expect(errs({ scores: { quality: 4, latency: 4, cost: 3, delivery: 5, overall: 5 } })).toMatch(/unknown score 'overall'/);
    expect(errs({ promptCategory: "poetry" })).toMatch(/promptCategory/);
    expect(errs({ notes: "x".repeat(501) })).toMatch(/at most 500/);
    expect(errs({ notes: "tab\there" })).toMatch(/control characters/);
    expect(validateReviewPayload(makeReview(did, { notes: "  line one\nline two  " })).notes).toBe("line one\nline two");
    for (const k of ["prompt", "reply", "output", "sessionSeed"]) expect(errs({ [k]: "x" })).toMatch(new RegExp(`'${k}' not allowed`));
    expect(errs({ surprise: 1 })).toMatch(/unknown field 'surprise'/);
  });
  it("requires an on-chain channel id", () => {
    expect(errs({ channelId: undefined })).toMatch(/channelId/);
    expect(errs({ channelId: "ch-label" })).toMatch(/channelId/);
  });
});

describe("on-chain review checks via RpcVerifier (5, 6, 12, 13, 14, 21)", () => {
  it("14. passes with settlementTx + channelId and no blockNumber; only storage + timestamp are read", async () => {
    const key = newKey();
    const { p, verifier, calls } = onChain(key);
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.httpStatus).toBe(201);
    expect(r.body).toMatchObject({ counted: true, verification: "passed" });
    expect(calls).not.toContain("chain_getBlock");
  });

  it("5. unknown channel → failed, not counted", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, {}, { missing: true });
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.body).toMatchObject({ verification: "failed", verificationNote: "channel_not_found", counted: false });
  });

  it("6. buyer or miner mismatch vs storage → failed", async () => {
    const key = newKey();
    const a = onChain(key, {}, { agent: randomSs58() });
    await bind(key.did, a.p.buyer as string);
    expect((await direct(key, a.p, { verifier: a.verifier })).body.verificationNote).toBe("buyer_mismatch");
    const b = onChain(key, {}, { miner: randomSs58() });
    await bind(key.did, b.p.buyer as string);
    expect((await direct(key, b.p, { verifier: b.verifier })).body.verificationNote).toBe("miner_mismatch");
  });

  it("12. channel still settling (SettlementPostedResult) → 202 pending, not counted", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, {}, { state: 1 });
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.httpStatus).toBe(202);
    expect(r.body).toMatchObject({ verification: "pending_verification", verificationNote: "channel_not_closed_yet:Settling", counted: false });
  });

  it("13. paidFlop must match a known paid amount exactly; raw Planck in paidFlop fails", async () => {
    /** A fresh DID with a counted FlopWatch receipt (paidFlop 0.0425) for a new channel. */
    async function withReceipt() {
      const ip = uniqueIp();
      const key = newKey();
      const token = await login(key, ip);
      const ch = chan();
      const rp = makePayload(key.did, { channelId: ch, settlementTx: null, blockNumber: null, maxFlop: "0.05", paidFlop: "0.0425" });
      const r = await submit(token, envelope(key, rp), ip);
      expect(r.json, JSON.stringify(r.json)).toMatchObject({ counted: true });
      return { key, base: { buyer: rp.buyer, miner: rp.miner, channelId: ch } };
    }
    // Raw planck typed into the decimal field: larger than the escrow → rejected outright.
    const a = await withReceipt();
    const raw = onChain(a.key, { ...a.base, paidFlop: "42500000000000000" });
    expect((await direct(a.key, raw.p, { verifier: raw.verifier })).body).toMatchObject({ verification: "failed", verificationNote: "paid_exceeds_escrow" });
    // Same amount written differently ("0.04250") is an exact planck match → paid_verified.
    const b = await withReceipt();
    const good = onChain(b.key, { ...b.base, paidFlop: "0.04250" });
    expect((await direct(b.key, good.p, { verifier: good.verifier })).body).toMatchObject({ counted: true, paidVerified: true, buyerProof: "receipt" });
    // A different amount → stored, excluded.
    const c = await withReceipt();
    const off = onChain(c.key, { ...c.base, paidFlop: "0.04" });
    expect((await direct(c.key, off.p, { verifier: off.verifier })).body).toMatchObject({ counted: false, excludedReason: "paid_flop_mismatch" });
  });

  it("paidFlop without a known paid amount counts, flagged paid_unverified", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, { paidFlop: "0.0425" });
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.body).toMatchObject({ counted: true, paidVerified: false });
    expect(r.body.verificationNote).toMatch(/paid_unverified/);
  });

  it("21. a testnet RPC serving the wrong genesis never counts", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, {}, { genesis: `0x${"22".repeat(32)}` });
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.httpStatus).toBe(202);
    expect(r.body).toMatchObject({ counted: false, verificationNote: "genesis_mismatch:testnet" });
  });

  it("freshness: more than 30 days after the channel opened → failed", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, {}, { openedAtMs: Date.now() - 31 * 86_400_000 });
    await bind(key.did, p.buyer as string);
    const r = await direct(key, p, { verifier });
    expect(r.body).toMatchObject({ verification: "failed", counted: false });
    expect(r.body.verificationNote).toMatch(/review_too_late/);
  });

  it("no settlementTx: stored, channel verified, not counted", async () => {
    const key = newKey();
    const { p, verifier } = onChain(key, { settlementTx: undefined });
    await bind(key.did, p.buyer as string);
    expect((await direct(key, p, { verifier })).body).toMatchObject({ verification: "passed", counted: false, excludedReason: "no_settlement_tx" });
  });
});

describe("buyer proof (8) and wallet signatures", () => {
  it("8. a binding for the buyer works; a binding for a different wallet is 403", async () => {
    const key = newKey();
    const p = makeReview(key.did);
    await bind(key.did, randomSs58());
    await expectHttpError(direct(key, p), 403, "buyer_not_proven");
    await bind(key.did, p.buyer as string);
    expect((await direct(key, p)).body.buyerProof).toBe("binding");
  });

  it("an sr25519 wallet signature over the review's JCS proves the buyer (raw or <Bytes> wrapped)", async () => {
    const sk = sr25519.secretFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const buyer = ss58Encode(sr25519.getPublicKey(sk));
    for (const wrap of [false, true]) {
      const key = newKey();
      const p = makeReview(key.did, { buyer });
      const msg = wrap ? `<Bytes>${jcs(p)}</Bytes>` : jcs(p);
      const walletSignature = bytesToHex(sr25519.sign(sk, utf8.encode(msg)));
      expect((await direct(key, p, { walletSignature })).body).toMatchObject({ counted: true, buyerProof: "wallet_signature" });
    }
    const key = newKey();
    const p = makeReview(key.did, { buyer });
    const wrongSig = bytesToHex(sr25519.sign(sk, utf8.encode("something else")));
    await expectHttpError(direct(key, p, { walletSignature: wrongSig }), 403, "buyer_not_proven");
  });

  it("flopwatchReceiptId must exist and match the review", async () => {
    const key = newKey();
    const p = makeReview(key.did, { flopwatchReceiptId: "f".repeat(64) });
    await bind(key.did, p.buyer as string);
    await expectHttpError(direct(key, p), 400, "receipt_not_found");
  });
});

describe("limits and caps (15, 16)", () => {
  it("15. the 21st review from one DID in a UTC day is 429", async () => {
    const key = newKey();
    const buyer = randomSs58();
    await bind(key.did, buyer);
    const e = roomy({ REVIEW_MAX_PER_BUYER_7D: "1000" });
    for (let i = 0; i < 20; i++) expect((await direct(key, makeReview(key.did, { buyer }), { env: e })).httpStatus).toBe(201);
    await expectHttpError(direct(key, makeReview(key.did, { buyer }), { env: e }), 429, "rate_limited");
  });

  it("16. the 11th counted review from one buyer in 7 days is stored as buyer_review_cap", async () => {
    const buyer = randomSs58();
    const results: Array<{ counted: boolean; excludedReason: string | null }> = [];
    for (let i = 0; i < 11; i++) {
      const key = newKey(); // different DIDs, same paying wallet
      await bind(key.did, buyer);
      results.push((await direct(key, makeReview(key.did, { buyer }))).body);
    }
    expect(results.slice(0, 10).every((r) => r.counted)).toBe(true);
    expect(results[10]).toMatchObject({ counted: false, excludedReason: "buyer_review_cap" });
  });
});

describe("aggregates, feeds and pages (17, 18, 19)", () => {
  it("17. shrinkage moves a single 5 toward 3.0; n=1 isn't ranked; miner page shows it with low n", async () => {
    expect(shrunkMean([5], { m: 5, prior: 3 })).toBeCloseTo(20 / 6);
    const s = computeReviewStats(
      [{ scores_json: JSON.stringify({ quality: 5, latency: null, cost: 5, delivery: 5 }), delivered: 1, paid_flop: null, paid_verified: 0, latency_ms: null, submitted_at: "2026-11-26T10:00:00Z", buyer: "b" }],
      { m: 5, prior: 3 },
    );
    expect(s).toMatchObject({ n: 1, qualityAvg: 3.33, latencyAvg: null, deliveryRate: 1, paidFlopPerUsefulMedian: null });
    // buyerScore: 0.4·3.333 + 0.2·3 (latency at prior) + 0.2·3.333 + 0.2·3.333
    expect(s.buyerScore).toBeCloseTo(0.4 * 20 / 6 + 0.2 * 3 + 0.4 * 20 / 6, 2);

    const key = newKey();
    const miner = randomSs58();
    const p = makeReview(key.did, { miner, notes: "Good <b>answer</b>" });
    await bind(key.did, p.buyer as string);
    expect((await direct(key, p)).body.counted).toBe(true);
    const board = await call("/reviews?network=testnet&t=17");
    expect(board.status).toBe(200);
    // Not in the ranked table (every test miner here has n < 5), but listed under "too few reviews".
    const table = board.text.slice(board.text.indexOf('<table class="board">'), board.text.indexOf("</table>"));
    expect(table).not.toContain(miner);
    expect(table).toContain("No miner has 5+ counted reviews");
    expect(board.text).toMatch(/Too few reviews to rank/);
    expect(board.text.slice(board.text.indexOf("Too few reviews to rank"))).toContain(encodeURIComponent(miner));
    const minerHtml = await call(`/miner/${miner}?network=testnet&t=17`);
    expect(minerHtml.status).toBe(200);
    expect(minerHtml.text).toContain("Buyer reviews");
    expect(minerHtml.text).toContain("low n");
    expect(minerHtml.text).toContain("Good &lt;b&gt;answer&lt;/b&gt;"); // notes are escaped
  });

  it("18. feeds and GET /v1/reviews/:id never expose buyer or DID; CORS on 200 and 404", async () => {
    const key = newKey();
    const p = makeReview(key.did);
    await bind(key.did, p.buyer as string);
    const { body } = await direct(key, p);
    const one = await call(`/v1/reviews/${body.id}`);
    expect(one.status).toBe(200);
    expect(one.headers.get("access-control-allow-origin")).toBe("*");
    expect(one.text).not.toContain(p.buyer as string);
    expect(one.text).not.toContain(key.did);
    const miss = await call(`/v1/reviews/${"0".repeat(64)}`);
    expect([miss.status, miss.headers.get("access-control-allow-origin")]).toEqual([404, "*"]);
    const mf = await call(`/feeds/miners/${p.miner}.json?network=testnet&t=18`);
    expect(mf.status).toBe(200);
    expect(mf.json.reviews.stats[0]).toMatchObject({ n: 1, ranked: false, lowSample: true });
    expect(mf.text).not.toContain(p.buyer as string);
    expect(mf.text).not.toContain(key.did);
    const rf = await call("/feeds/reviews.json?network=testnet&window=all&t=18");
    expect(rf.json.minNForRanking).toBe(5);
    expect(rf.text).not.toContain(key.did);
    const meta = await call("/feeds/meta.json?t=18");
    expect(meta.json).toHaveProperty("countedLiveReviews");
    expect(meta.json).toHaveProperty("pendingReviews");
    expect(meta.json.sampleReviews).toBe(0);
  });

  it("19. miner page links FLOPScan account + markets reliability; /reviews and /?view=reviews render with JS off", async () => {
    const key = newKey();
    const p = makeReview(key.did);
    await bind(key.did, p.buyer as string);
    await direct(key, p);
    const m = await call(`/miner/${p.miner}?network=testnet&t=19`);
    expect(m.text).toContain(`https://testnet.flopscan.io/account/${p.miner}`);
    expect(m.text).toContain("https://testnet.flopscan.io/markets?tab=reliability");
    for (const path of ["/reviews?t=19", "/?view=reviews&t=19"]) {
      const r = await call(path);
      expect(r.status).toBe(200);
      expect(r.text).toContain("<table class=\"board\">");
      expect(r.text).toContain("Buyer score");
    }
    const home = await call("/?t=19");
    expect(home.text).toContain("Signed. Settled. Watched."); // receipts board stays the default
  });
});

describe("CLI mapper (20)", () => {
  const settled = {
    reply: "THE MODEL'S ANSWER",
    sessionSeed: "0xsecret",
    receipts: [{ turnIndex: 0, output: "turn output", latencyMs: 900 }],
    miner: "5EA9iNrZzNS2eAiZNQv55pA1hUYGVS8aK4ZQsfxuQcnx48ZD",
    channelId: "0x1F7C49CEB3071D66D3A177CE8F1E114F9B23CA681659EBC7F2336694230E4B27",
    settleTx: "0x2ac387ea08d6863d68bb10b138224631a84681c32be076ada8b6c01a5b5985c7",
    settlement: { channelId: "0x1f7c", minerPaid: 42_500_000_000_000_000n, burned: 0n, cooperative: true, txHash: "0x2ac3" },
  };
  const input = {
    network: "testnet" as const, buyer: "5FFWxTAPCAbbeGbPWQzL8RbDTCEvUr2doBeowTPRFbLyNSBt", model: "qwen/qwen3-8b",
    scores: { quality: 4, latency: 3, cost: 4, delivery: 5 }, delivered: true,
  };
  it("maps a SettledResult to a valid payload without reply/output/seed", () => {
    const { payload, finalized } = reviewFromSession(settled, input);
    expect(finalized).toBe(true);
    expect(payload.paidFlop).toBe("0.0425");
    expect(payload.channelId).toBe(settled.channelId.toLowerCase());
    const text = JSON.stringify(payload);
    for (const s of ["THE MODEL'S ANSWER", "turn output", "0xsecret", "reply", "sessionSeed", "output"]) expect(text).not.toContain(s);
    expect(validateReviewPayload({ ...payload, did: newKey().did, nonce: randomHex(16), submittedAt: new Date().toISOString() }).ok).toBe(true);
  });
  it("a SettlementPostedResult sets no paidFlop", () => {
    const posted = { ...settled, settlement: { channelId: "0x1f7c", finalRoot: "0xab", aggregateGn: "5", challengeEnd: 123, txHash: "0x2ac3" } };
    const { payload, finalized, warnings } = reviewFromSession(posted, input);
    expect(finalized).toBe(false);
    expect(payload).not.toHaveProperty("paidFlop");
    expect(warnings.join(" ")).toMatch(/SettlementPostedResult/);
  });
  it("planckToFlop is exact", () => {
    expect(planckToFlop(42_500_000_000_000_000n)).toBe("0.0425");
    expect(planckToFlop("1000000000000000000")).toBe("1");
    expect(planckToFlop(1n)).toBe("0.000000000000000001");
  });
});

describe("22. receipts are unchanged", () => {
  it("receipt SAMPLE banner still keys off counted receipts, not reviews", async () => {
    const key = newKey();
    const p = makeReview(key.did);
    await bind(key.did, p.buyer as string);
    await direct(key, p);
    const meta = await call("/feeds/meta.json?t=22");
    expect(meta.json.countedLiveReceipts).toBe(0);
    expect(meta.json.dataLabel).toBe("SAMPLE — NOT LIVE DATA");
  });
});
