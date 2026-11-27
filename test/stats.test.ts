import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { computeStats, percentile, median, type ReceiptRow } from "../src/stats/aggregate";
import { call, envelope, login, makePayload, newKey, randomSs58, submit, uniqueIp } from "./helpers";

const row = (o: Partial<ReceiptRow>): ReceiptRow => ({
  status: "settled", ok: 1, latency_ms: null, paid_flop: null, prompt_tokens: null, completion_tokens: null,
  error_class: null, channel_id: "c", started_at: "2026-11-20T10:00:00Z", finished_at: null, ...o,
});

describe("aggregation (acceptance 6)", () => {
  it("computes success rate, settlement rate, latency and prices", () => {
    const s = computeStats([
      row({ latency_ms: 100, paid_flop: "0.002", prompt_tokens: 10, completion_tokens: 10 }),
      row({ latency_ms: 200, paid_flop: "0.004", prompt_tokens: 20, completion_tokens: 20 }),
      row({ status: "failed", ok: 0, latency_ms: 900, error_class: "miner-unreachable" }),
      row({ status: "timeout", ok: 0, latency_ms: 30000 }),
      row({ status: "challenged", ok: 0, latency_ms: 300 }),
      row({ status: "pending", ok: 0, finished_at: "2026-11-21T09:00:00Z" }),
    ]);
    expect(s.n).toBe(6);
    expect(s.successRate).toBeCloseTo(2 / 5); // pending excluded from denominator
    expect(s.settlementRate).toBeCloseTo(2 / 4); // settled / (settled + challenged + timeout-after-accept)
    expect(s.latencyP50).toBe(300);
    expect(s.latencyP95).toBe(30000);
    expect(s.priceSessionMedian).toBeCloseTo(0.003);
    expect(s.priceTokenMedian).toBeCloseTo(0.0001);
    expect(s.lastSeen).toBe("2026-11-21T09:00:00Z");
  });

  it("never treats maxFlop as a price", () => {
    expect(computeStats([row({ paid_flop: null })]).priceSessionMedian).toBeNull();
  });

  it("percentile/median helpers", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 50)).toBeNull();
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("feeds reflect counted receipts per miner and redact buyers and DIDs", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const miner = randomSs58();
    const buyer = randomSs58();
    const shapes = [
      { status: "settled", ok: true, latencyMs: 100, paidFlop: "0.002" },
      { status: "settled", ok: true, latencyMs: 300, paidFlop: "0.004" },
      { status: "failed", ok: false, latencyMs: 500, paidFlop: null, errorClass: "miner-unreachable", settlementTx: null, blockNumber: null },
    ];
    for (const s of shapes) {
      const r = await submit(token, envelope(key, makePayload(key.did, { miner, buyer, ...s })), ip);
      expect(r.status).toBe(201);
    }
    const feed = await call("/feeds/miners.json?network=testnet");
    expect(feed.status).toBe(200);
    // Second hit is served from the edge cache (regression: immutable cached headers).
    const again = await call("/feeds/miners.json?network=testnet");
    expect(again.status).toBe(200);
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    const all = feed.json.miners.find((m: any) => m.miner === miner && m.window === "all");
    expect(all).toMatchObject({ n: 3, lowSample: true, latencyMsP50: 300, flopPerSessionMedian: 0.003 });
    expect(all.successRate).toBeCloseTo(2 / 3);
    expect(feed.text).not.toContain(buyer);
    expect(feed.text).not.toContain(key.did);

    const one = await call(`/feeds/miners/${miner}.json`);
    expect(one.status).toBe(200);
    expect(one.json.receipts).toHaveLength(3);
    expect(one.text).not.toContain(buyer);
    expect(one.text).not.toContain(key.did);
    for (const r of one.json.receipts) {
      expect(r).not.toHaveProperty("buyer");
      expect(r).not.toHaveProperty("did");
    }
  });

  it("shows the SAMPLE banner until a live counted receipt exists, then hides sample rows", async () => {
    await env.DB.prepare("DELETE FROM receipts").run();
    await env.DB.prepare("DELETE FROM miner_stats").run();
    const sampleMiner = randomSs58();
    await env.DB.prepare(
      `INSERT INTO receipts (id, network, did, buyer, miner, model, status, ok, max_flop, started_at, submitted_at, nonce,
        payload_json, signature, received_at, verification, counted, is_sample, latency_ms)
       VALUES ('s1','testnet','did:key:sample',?, ?, 'sample-model','settled',1,'0.01','2026-11-20T10:00:00Z','2026-11-20T10:00:01Z','n1','{}','',?, 'passed',1,1,500)`,
    ).bind(randomSs58(), sampleMiner, Date.now()).run();
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stats_dirty','1')").run();

    let home = await call("/?t=sample-banner");
    expect(home.text).toContain("SAMPLE — NOT LIVE DATA");
    expect(home.text).toContain(sampleMiner.slice(0, 6));

    // A mock-verified receipt counts locally but must never flip the board to LIVE.
    const key = newKey();
    const ip = uniqueIp();
    const token = await login(key, ip);
    const r = await submit(token, envelope(key, makePayload(key.did)), ip);
    expect(r.json.counted).toBe(true);
    home = await call("/?x=0");
    expect(home.text).toContain("SAMPLE — NOT LIVE DATA");

    // Simulate a receipt the real chain verifier passed.
    await env.DB.prepare("UPDATE receipts SET verified_by = 'rpc' WHERE id = ?").bind(r.json.id).run();
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stats_dirty','1')").run();
    home = await call("/?x=1");
    expect(home.text).toContain("LIVE TESTNET DATA");
    expect(home.text).not.toContain("SAMPLE — NOT LIVE DATA");
    expect(home.text).not.toContain(sampleMiner.slice(0, 6));
  });
});

describe("SHOW_SAMPLE_DATA", () => {
  it('"false" hides sample rows and labels the board LIVE TESTNET DATA without faking a live receipt', async () => {
    const { buildMeta } = await import("../src/stats/feeds");
    const { recomputeAll } = await import("../src/stats/aggregate");
    await env.DB.prepare("DELETE FROM receipts").run();
    await env.DB.prepare(
      `INSERT INTO receipts (id, network, did, buyer, miner, model, status, ok, max_flop, started_at, submitted_at, nonce,
        payload_json, signature, received_at, verification, counted, is_sample, latency_ms)
       VALUES ('s-hide','testnet','did:key:sample',?, ?, 'sample-model','settled',1,'0.01','2026-11-20T10:00:00Z','2026-11-20T10:00:01Z','n-hide','{}','',?, 'passed',1,1,500)`,
    ).bind(randomSs58(), randomSs58(), Date.now()).run();
    const off = { ...env, SHOW_SAMPLE_DATA: "false" } as typeof env;
    await recomputeAll(off);
    const meta = await buildMeta(off);
    expect(meta).toMatchObject({ dataLabel: "LIVE TESTNET DATA", live: true, countedLiveReceipts: 0, sampleDataShown: false });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM miner_stats WHERE is_sample = 1").first<{ n: number }>();
    expect(rows!.n).toBe(0);
    // Default (tests) still shows samples.
    await recomputeAll(env);
    expect((await buildMeta(env)).dataLabel).toBe("SAMPLE — NOT LIVE DATA");
  });
});
