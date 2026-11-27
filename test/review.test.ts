import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { issueChallenge, verifyChallenge, SIWD_STATEMENT } from "../src/auth/challenge";
import { HttpError } from "../src/lib/http";
import { computeStats, type ReceiptRow } from "../src/stats/aggregate";
import { call, envelope, getChallenge, login, makePayload, newKey, randomSs58, sign, submit, uniqueIp } from "./helpers";

const SITE = { domain: "board.test", uri: "https://board.test" };

describe("review fixes", () => {
  it("challenge statement names Flopwatch", async () => {
    expect(SIWD_STATEMENT).toBe("Sign in to Flopwatch to submit miner receipts and reviews. This signature does not move funds.");
    expect((await getChallenge(uniqueIp())).statement).toBe(SIWD_STATEMENT);
  });

  it("an unused nonce is rejected once its expiresAt has passed (and accepted just before)", async () => {
    const key = newKey();
    const t0 = Date.now();
    const ch = await issueChallenge(env, SITE, uniqueIp(), t0);
    const body = { did: key.did, challenge: ch, signature: sign(key, ch) };
    const expiresAt = Date.parse(ch.expiresAt);
    for (const now of [expiresAt, expiresAt + 1, expiresAt + 3_600_000]) {
      const err = await verifyChallenge(env, SITE, body, now).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe("challenge_expired");
    }
    // Still unused, so a verify just before expiry succeeds.
    expect(await verifyChallenge(env, SITE, body, expiresAt - 1)).toBe(key.did);
  });

  it("logout clears the cookie with the same attributes login sets", async () => {
    const ip = uniqueIp();
    const token = await login(newKey(), ip);
    const r = await call("/v1/auth/logout", { method: "POST", token, ip, body: "{}" });
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/flop_session=;/);
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("GET /v1/receipts/:id serves sample ids too, as JSON, without buyer or DID", async () => {
    const buyer = randomSs58();
    const id = "sample-1156e9f2b4ba1b188bafc56c2d6a03a2";
    await env.DB.prepare(
      `INSERT INTO receipts (id, network, did, buyer, miner, model, status, ok, max_flop, started_at, submitted_at, nonce,
        payload_json, signature, received_at, verification, counted, is_sample)
       VALUES (?, 'testnet', 'did:key:SAMPLE-NOT-LIVE', ?, ?, 'sample-model', 'settled', 1, '0.01', '2026-11-20T10:00:00Z',
               '2026-11-20T10:00:01Z', 'nonce-review-1', '{}', 'SAMPLE', ?, 'passed', 1, 1)`,
    ).bind(id, buyer, randomSs58(), Date.now()).run();
    const r = await call(`/v1/receipts/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, sample: true });
    expect(r.text).not.toContain(buyer);
    expect(r.text).not.toContain("did:key");
    const missing = await call("/v1/receipts/not-an-id");
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("/data snapshot paths exist even before the first cron run", async () => {
    for (const p of ["/data/miners.json", "/data/meta.json", "/data/index.json"]) {
      const r = await call(p);
      expect(r.status, p).toBe(200);
      expect(r.json.schemaVersion).toBe(1);
    }
    expect((await call("/data/nope.json")).status).toBe(404);
  });

  it("aggregates are rounded", () => {
    const row = (paid: string): ReceiptRow => ({
      status: "settled", ok: 1, latency_ms: 100, paid_flop: paid, prompt_tokens: 7, completion_tokens: 3,
      error_class: null, channel_id: "c", started_at: "2026-11-20T10:00:00Z", finished_at: null,
    });
    const s = computeStats([row("0.0041"), row("0.0044345"), row("0.005")]);
    expect(String(s.priceSessionMedian)).toBe("0.0044345");
    const t = computeStats([row("0.0042675"), row("0.0042675000000000005")]);
    expect(t.priceSessionMedian).toBe(0.0042675);
    const third = computeStats([row("0.001"), { ...row("0.001"), status: "failed", ok: 0 }, { ...row("0.001"), status: "failed", ok: 0 }]);
    expect(third.successRate).toBe(0.3333);
  });

  it("miner page defaults to testnet, and channel ids aren't double-prefixed", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const miner = randomSs58();
    await submit(token, envelope(key, makePayload(key.did, { miner, channelId: "ch-abc123" })), ip);
    await submit(token, envelope(key, makePayload(key.did, { miner, channelId: 77 })), ip);
    const page = await call(`/miner/${miner}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Network · testnet");
    expect(page.text).not.toContain("Network · all");
    expect(page.text).toContain("ch-abc123");
    expect(page.text).not.toContain("ch ch-");
    expect(page.text).toContain("ch 77");
  });

  it("pages: trailing slash 301, favicon, HSTS", async () => {
    const slash = await call("/methodology/?x=1", { redirect: "manual" });
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe("/methodology?x=1");
    const fav = await call("/favicon.ico", { redirect: "manual" });
    expect(fav.status).toBe(301);
    expect(fav.headers.get("location")).toBe("/favicon.svg");
    expect((await call("/methodology")).headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    // API paths are not redirected.
    expect((await call("/v1/receipts/", { redirect: "manual" })).status).toBe(404);
  });
});

describe("tester follow-ups", () => {
  it("/v1/receipts/:id is readable cross-origin (200 and 404)", async () => {
    const miss = await call("/v1/receipts/" + "0".repeat(64));
    expect(miss.status).toBe(404);
    expect(miss.headers.get("access-control-allow-origin")).toBe("*");
    expect(miss.json.error).toBe("not_found");
  });
});
