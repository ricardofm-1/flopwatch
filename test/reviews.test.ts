import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { submitReceipt } from "../src/receipts/submit";
import { isValidRating, validateReceiptPayload } from "../src/receipts/schema";
import { computeRatingStats, shrunkMean } from "../src/reviews/aggregate";
import type { Env } from "../src/env";
import { call, envelope, login, makePayload, newKey, randomSs58, submit, uniqueIp, type TestKey } from "./helpers";

/** Generous limits for tests that submit many receipts directly (rate limiting has its own tests). */
const roomy = () => ({ ...env, RATE_LIMIT_SUBMIT_HOURLY: "1000", RATE_LIMIT_SUBMIT_DAILY: "1000" }) as Env;
const direct = (key: TestKey, payload: Record<string, unknown>) =>
  submitReceipt(roomy(), { sessionDid: key.did, ip: uniqueIp() }, envelope(key, payload));

describe("the review is part of the receipt", () => {
  it("one signed payload, one call: receipt + rating stored and counted together", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const p = makePayload(key.did, { review: { rating: 4.5, notes: "  Correct answer.\nA little slow.  " } });
    const r = await submit(token, envelope(key, p), ip);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ counted: true });
    const row = await env.DB.prepare("SELECT rating, review_notes, review_excluded FROM receipts WHERE id = ?").bind(r.json.id).first();
    expect(row).toEqual({ rating: 4.5, review_notes: "Correct answer.\nA little slow.", review_excluded: null });
    const pub = await call(`/v1/receipts/${r.json.id}`);
    expect(pub.json.review).toEqual({ rating: 4.5, notes: "Correct answer.\nA little slow.", excludedReason: null });
  });

  it("the rating is covered by the receipt signature (changing it breaks the signature)", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const env1 = envelope(key, makePayload(key.did, { review: { rating: 2 } }));
    const tampered = { ...env1, payload: { ...env1.payload, review: { rating: 5 } } };
    expect((await submit(token, tampered, ip)).json.error).toBe("invalid_receipt_signature");
  });

  it("a receipt without a review is rejected", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const p = makePayload(key.did) as Record<string, unknown>;
    delete p.review;
    const r = await submit(token, envelope(key, p), ip);
    expect([r.status, r.json.error]).toEqual([400, "invalid_receipt"]);
    expect(r.json.errors.join(" ")).toMatch(/review is required/);
  });

  it("POST /v1/reviews is gone and points to /v1/receipts", async () => {
    const r = await call("/v1/reviews", { method: "POST", body: "{}" });
    expect(r.status).toBe(410);
    expect(r.json.message).toMatch(/POST \/v1\/receipts/);
  });
});

describe("rating: 1–5 stars in 0.5 steps", () => {
  it("accepts every half step from 1 to 5", () => {
    for (let x = 1; x <= 5; x += 0.5) expect(isValidRating(x), String(x)).toBe(true);
  });
  it.each([0, 0.5, 5.5, 6, 4.25, 3.3, -1, Number.NaN, "4", null, true])("rejects %p", (v) => {
    expect(isValidRating(v)).toBe(false);
    const res = validateReceiptPayload(makePayload(newKey().did, { review: { rating: v } }));
    expect(res.errors.join(" ")).toMatch(/review.rating must be 1–5 in 0.5 steps/);
  });
  it("validates notes and rejects unknown review fields", () => {
    const did = newKey().did;
    const errs = (review: unknown) => validateReceiptPayload(makePayload(did, { review })).errors.join(" | ");
    expect(errs({ rating: 3, notes: "x".repeat(501) })).toMatch(/at most 500/);
    expect(errs({ rating: 3, notes: "tab\there" })).toMatch(/control characters/);
    expect(errs({ rating: 3, notes: 5 })).toMatch(/notes must be a string/);
    expect(errs({ rating: 3, scores: { quality: 5 } })).toMatch(/unknown review field 'scores'/);
    expect(errs("4.5")).toMatch(/review is required/);
    expect(validateReceiptPayload(makePayload(did, { review: { rating: 3.5, notes: "fine" } })).ok).toBe(true);
  });
});

describe("when a rating counts", () => {
  it("a self-dealing receipt's rating never counts", async () => {
    const key = newKey();
    const w = randomSs58();
    const { body } = await direct(key, makePayload(key.did, { buyer: w, miner: w, review: { rating: 5 } }));
    expect(body).toMatchObject({ counted: false, excludedReason: "self_dealing:buyer_is_miner" });
    const s = await env.DB.prepare("SELECT COUNT(*) AS n FROM miner_review_stats WHERE miner = ?").bind(w).first<{ n: number }>();
    expect(s!.n).toBe(0);
  });

  it("a pending receipt's rating isn't counted until the receipt verifies", async () => {
    const key = newKey();
    const miner = randomSs58();
    const { httpStatus } = await direct(key, makePayload(key.did, { miner, channelId: "mock-unavailable", review: { rating: 5 } }));
    expect(httpStatus).toBe(202);
    const s = await env.DB.prepare("SELECT COUNT(*) AS n FROM miner_review_stats WHERE miner = ?").bind(miner).first<{ n: number }>();
    expect(s!.n).toBe(0);
  });

  it("failed sessions are rated too; delivered rate comes from the receipt's ok", async () => {
    const key = newKey();
    const miner = randomSs58();
    await direct(key, makePayload(key.did, { miner, review: { rating: 4 } }));
    await direct(key, makePayload(key.did, { miner, status: "failed", ok: false, errorClass: "miner-unreachable", paidFlop: null, settlementTx: null, review: { rating: 1 } }));
    const f = await call(`/feeds/miners/${miner}.json?network=testnet&t=fail`);
    const all = f.json.reviews.stats.find((x: { window: string }) => x.window === "all");
    expect(all).toMatchObject({ n: 2, nDelivered: 1, deliveryRate: 0.5, ratingMedian: 2.5 });
    expect(all.rating).toBeCloseTo((15 + 5) / 7, 2);
  });

  it("the 11th rating from one buyer wallet in 7 days is set aside; the receipt still counts", async () => {
    const buyer = randomSs58();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const key = newKey();
      const { body } = await direct(key, makePayload(key.did, { buyer, review: { rating: 5 } }));
      expect(body.counted).toBe(true);
      ids.push(body.id);
    }
    const rows = await env.DB.prepare(`SELECT review_excluded FROM receipts WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ review_excluded: string | null }>();
    expect(rows.results.filter((r) => r.review_excluded === null)).toHaveLength(10);
    expect(rows.results.filter((r) => r.review_excluded === "buyer_review_cap")).toHaveLength(1);
  });
});

describe("aggregates, feeds and pages", () => {
  it("an empty board says so instead of showing empty tables", async () => {
    await env.DB.prepare("DELETE FROM miner_review_stats").run();
    const r = await call("/reviews?network=devnet&t=empty");
    expect(r.text).toContain("No ratings yet. Ratings arrive with each verified receipt.");
    expect(r.text).not.toContain('id="ranked-table"');
  });

  it("shrinkage: a single 5 shows as 3.33; n < 5 isn't ranked; miner page shows it with low n", async () => {
    expect(shrunkMean([5], { m: 5, prior: 3 })).toBeCloseTo(20 / 6);
    const s = computeRatingStats([{ rating: 5, ok: 1, paid_flop: "0.04", submitted_at: "2026-11-26T10:00:00Z", buyer: "b" }], { m: 5, prior: 3 });
    expect(s).toMatchObject({ n: 1, ratingAvg: 3.33, ratingMedian: 5, deliveryRate: 1, paidFlopPerUsefulMedian: null });

    const key = newKey();
    const miner = randomSs58();
    await direct(key, makePayload(key.did, { miner, review: { rating: 5, notes: "Good <b>answer</b>" } }));
    const board = await call("/reviews?network=testnet&t=agg");
    const section = (id: string) => {
      const i = board.text.indexOf(`id="${id}"`);
      return i < 0 ? "" : board.text.slice(i, board.text.indexOf("</table>", i));
    };
    expect(section("ranked-table")).not.toContain(encodeURIComponent(miner));
    const unranked = section("unranked-table");
    expect(unranked).toContain(encodeURIComponent(miner)); // visible right away, with its rating
    expect(unranked).toContain("3.33 ★");
    expect(unranked).toContain("low n");
    const page = await call(`/miner/${miner}?network=testnet&t=agg`);
    expect(page.text).toContain("Buyer ratings");
    expect(page.text).toContain("3.33 ★");
    expect(page.text).toContain("low n");
    expect(page.text).toContain("Good &lt;b&gt;answer&lt;/b&gt;");
  });

  it("five ratings rank a miner; the main board shows a Rating column", async () => {
    const miner = randomSs58();
    for (const rating of [5, 4.5, 5, 4, 5]) {
      const key = newKey();
      await direct(key, makePayload(key.did, { miner, review: { rating } }));
    }
    const rf = await call("/feeds/reviews.json?network=testnet&window=all&t=rank");
    const row = rf.json.miners.find((m: { miner: string }) => m.miner === miner);
    expect(row).toMatchObject({ n: 5, ranked: true, ratingMedian: 5 });
    expect(row.rating).toBeCloseTo((15 + 23.5) / 10, 2);
    const board = await call("/reviews?network=testnet&t=rank");
    const i = board.text.indexOf('id="ranked-table"');
    expect(board.text.slice(i, board.text.indexOf("</table>", i))).toContain(encodeURIComponent(miner));
    const home = await call("/?t=rank");
    expect(home.text).toContain('<th scope="col" class="num">Rating</th>');
    expect(home.text).toContain("3.85 ★");
  });

  it("feeds never expose buyer or DID; meta has rating counts", async () => {
    const key = newKey();
    const p = makePayload(key.did, { review: { rating: 3 } });
    await direct(key, p);
    for (const path of [`/feeds/miners/${p.miner}.json?network=testnet&t=red`, "/feeds/reviews.json?t=red"]) {
      const r = await call(path);
      expect(r.status, path).toBe(200);
      expect(r.text).not.toContain(p.buyer);
      expect(r.text).not.toContain(key.did);
    }
    const meta = await call("/feeds/meta.json?t=red");
    expect(meta.json).toHaveProperty("countedLiveReviews");
    expect(meta.json).toHaveProperty("pendingReviews");
  });

  it("miner page links FLOPScan account + markets; /reviews and /?view=reviews render with JS off", async () => {
    const key = newKey();
    const p = makePayload(key.did, { review: { rating: 4 } });
    await direct(key, p);
    const m = await call(`/miner/${p.miner}?network=testnet&t=links`);
    expect(m.text).toContain(`https://testnet.flopscan.io/account/${p.miner}`);
    expect(m.text).toContain("https://testnet.flopscan.io/markets?tab=reliability");
    for (const path of ["/reviews?t=links", "/?view=reviews&t=links"]) {
      const r = await call(path);
      expect(r.status).toBe(200);
      expect(r.text).toContain("Buyer ratings");
    }
  });
});
