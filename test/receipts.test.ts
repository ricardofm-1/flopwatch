import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, envelope, login, makePayload, newKey, randomSs58, submit, uniqueIp } from "./helpers";

describe("receipt submission (acceptance 3, 4)", () => {
  it("accepts a validly signed receipt and counts it", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const r = await submit(token, envelope(key, makePayload(key.did)), ip);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ verification: "passed", counted: true, status: "counted" });
    expect(r.json.id).toMatch(/^[0-9a-f]{64}$/);
    const obj = await env.BUCKET.get(
      (await env.DB.prepare("SELECT r2_key FROM receipts WHERE id = ?").bind(r.json.id).first<{ r2_key: string }>())!.r2_key,
    );
    expect(obj).not.toBeNull();
  });

  it("rejects a receipt whose field was tampered after signing", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const env1 = envelope(key, makePayload(key.did));
    const tampered = { ...env1, payload: { ...env1.payload, latencyMs: 12 } };
    const r = await submit(token, tampered, ip);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_receipt_signature");
  });

  it("requires a session, and payload.did must match it", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const other = newKey();
    const noAuth = await call("/v1/receipts", { method: "POST", ip, body: JSON.stringify(envelope(key, makePayload(key.did))) });
    expect(noAuth.status).toBe(401);
    const token = await login(key, ip);
    const r = await submit(token, envelope(other, makePayload(other.did)), ip);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("did_mismatch");
  });

  it("rejects duplicates by receipt, nonce and settlement tx", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const p = makePayload(key.did);
    expect((await submit(token, envelope(key, p), ip)).status).toBe(201);
    const same = await submit(token, envelope(key, p), ip);
    expect(same.status).toBe(409);
    const sameNonce = await submit(token, envelope(key, makePayload(key.did, { nonce: p.nonce })), ip);
    expect(sameNonce.status).toBe(409);
    expect(sameNonce.json.error).toBe("duplicate_nonce");
    const sameTx = await submit(token, envelope(key, makePayload(key.did, { settlementTx: p.settlementTx })), ip);
    expect(sameTx.status).toBe(409);
    expect(sameTx.json.error).toBe("duplicate_settlement");
  });

  it("stores a self-dealing receipt but never counts it", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const wallet = randomSs58();
    const r = await submit(token, envelope(key, makePayload(key.did, { buyer: wallet, miner: wallet })), ip);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ counted: false, excludedReason: "self_dealing:buyer_is_miner", status: "stored_not_counted" });
    const row = await env.DB.prepare("SELECT counted, excluded_reason FROM receipts WHERE id = ?").bind(r.json.id).first();
    expect(row).toMatchObject({ counted: 0, excluded_reason: "self_dealing:buyer_is_miner" });
    const stats = await env.DB.prepare("SELECT COUNT(*) AS n FROM miner_stats WHERE miner = ?").bind(wallet).first<{ n: number }>();
    expect(stats!.n).toBe(0);
  });

  it("excludes receipts where the submitter DID is bound to the miner wallet", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const miner = randomSs58();
    await env.DB.prepare(
      "INSERT INTO bindings (did, wallet, network, payload_json, wallet_signature, did_signature, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(key.did, miner, "testnet", "{}", "00", "00", Date.now()).run();
    const r = await submit(token, envelope(key, makePayload(key.did, { miner })), ip);
    expect(r.json.excludedReason).toBe("self_dealing:submitter_bound_to_miner");
    expect(r.json.counted).toBe(false);
  });

  it("returns 202 pending_verification when the chain check is unavailable", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const r = await submit(token, envelope(key, makePayload(key.did, { channelId: "mock-unavailable" })), ip);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "pending_verification", counted: false });
  });

  it("validates schema and strips nothing silently", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const bad = await submit(token, envelope(key, makePayload(key.did, { reply: "the model said…", ok: true, status: "failed" })), ip);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_receipt");
    expect(bad.json.errors.join(" ")).toMatch(/reply/);
    expect(bad.json.errors.join(" ")).toMatch(/ok=true requires/);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const stale = await submit(token, envelope(key, makePayload(key.did, { submittedAt: future, finishedAt: future })), ip);
    expect(stale.status).toBe(400);
    expect(stale.json.error).toBe("stale_receipt");
  });

  it("serves public receipt metadata without buyer or DID", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const p = makePayload(key.did);
    const r = await submit(token, envelope(key, p), ip);
    const pub = await call(`/v1/receipts/${r.json.id}`);
    expect(pub.status).toBe(200);
    expect(pub.text).not.toContain(p.buyer);
    expect(pub.text).not.toContain(key.did);
    expect(pub.json.miner).toBe(p.miner);
  });
});

describe("rate limits (acceptance 5)", () => {
  it("returns 429 with Retry-After once the per-DID hourly limit is exceeded", async () => {
    const key = newKey();
    const token = await login(key, uniqueIp());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await submit(token, envelope(key, makePayload(key.did)), uniqueIp())).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("limits per IP across DIDs", async () => {
    const ip = uniqueIp();
    let last = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 6; i++) {
      const key = newKey();
      const token = await login(key, uniqueIp());
      const r = await submit(token, envelope(key, makePayload(key.did)), ip);
      last = r.status;
      retryAfter = r.headers.get("retry-after");
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
