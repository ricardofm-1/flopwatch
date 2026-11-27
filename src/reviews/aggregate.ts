import type { Env } from "../env";
import { intVar } from "../env";
import { median, percentile, WINDOWS, type StatsWindow } from "../stats/aggregate";
import { SCORE_KEYS, type ScoreKey, type Scores } from "./schema";

/** FLOPWATCH-BUYER-REVIEWS-SPEC §8. Counted reviews only. */
export interface ReviewRow {
  scores_json: string;
  delivered: number;
  paid_flop: string | null;
  paid_verified: number;
  latency_ms: number | null;
  submitted_at: string;
  buyer: string;
}

export interface ReviewStats {
  n: number;
  nDelivered: number;
  deliveryRate: number | null;
  qualityAvg: number | null;
  latencyAvg: number | null;
  costAvg: number | null;
  deliveryAvg: number | null;
  qualityMedian: number | null;
  buyerScore: number | null;
  paidFlopPerUsefulMedian: number | null;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  lastReviewedAt: string | null;
  buyerConcentration: "high" | null;
}

export interface Shrinkage {
  m: number;
  prior: number;
}

export function shrinkageFrom(env: Env): Shrinkage {
  const prior = Number(env.REVIEW_BAYES_PRIOR ?? "3");
  return { m: intVar(env.REVIEW_BAYES_M, 5), prior: Number.isFinite(prior) ? prior : 3 };
}

const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

/** Bayesian (shrunk) mean: (m·prior + Σscore) / (m + nScored). */
export function shrunkMean(scores: number[], s: Shrinkage): number {
  const sum = scores.reduce((a, b) => a + b, 0);
  return (s.m * s.prior + sum) / (s.m + scores.length);
}

export const BUYER_SCORE_WEIGHTS: Record<ScoreKey, number> = { quality: 0.4, latency: 0.2, cost: 0.2, delivery: 0.2 };
export const MIN_PAID_FOR_MEDIAN = 3;

export function computeReviewStats(rows: ReviewRow[], s: Shrinkage): ReviewStats {
  const n = rows.length;
  const byKey: Record<ScoreKey, number[]> = { quality: [], latency: [], cost: [], delivery: [] };
  for (const r of rows) {
    let sc: Partial<Scores> = {};
    try {
      sc = JSON.parse(r.scores_json) as Scores;
    } catch {
      /* stored by us; ignore malformed */
    }
    for (const k of SCORE_KEYS) {
      const v = sc[k];
      if (typeof v === "number") byKey[k].push(v);
    }
  }
  // Shrunk means feed the buyer score even for unrated dimensions (they sit at the prior);
  // the displayed per-dimension average is null when nobody rated it.
  const shrunk = Object.fromEntries(SCORE_KEYS.map((k) => [k, shrunkMean(byKey[k], s)])) as Record<ScoreKey, number>;
  const shown = (k: ScoreKey) => (byKey[k].length ? r2(shrunk[k]) : null);
  const buyerScore = n ? SCORE_KEYS.reduce((acc, k) => acc + BUYER_SCORE_WEIGHTS[k] * shrunk[k], 0) : null;

  const nDelivered = rows.filter((r) => r.delivered === 1).length;
  const paidUseful = rows
    .filter((r) => r.delivered === 1 && r.paid_verified === 1 && r.paid_flop !== null)
    .map((r) => Number(r.paid_flop))
    .filter(Number.isFinite);
  const latencies = rows.map((r) => r.latency_ms).filter((x): x is number => typeof x === "number");

  const perBuyer = new Map<string, number>();
  for (const r of rows) perBuyer.set(r.buyer, (perBuyer.get(r.buyer) ?? 0) + 1);
  const topShare = n ? Math.max(...perBuyer.values()) / n : 0;

  let last: string | null = null;
  for (const r of rows) if (!last || r.submitted_at > last) last = r.submitted_at;

  return {
    n,
    nDelivered,
    deliveryRate: n ? r4(nDelivered / n) : null,
    qualityAvg: shown("quality"),
    latencyAvg: shown("latency"),
    costAvg: shown("cost"),
    deliveryAvg: shown("delivery"),
    qualityMedian: median(byKey.quality),
    buyerScore: r2(buyerScore),
    paidFlopPerUsefulMedian: paidUseful.length >= MIN_PAID_FOR_MEDIAN ? Number((median(paidUseful) as number).toPrecision(6)) : null,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    lastReviewedAt: last,
    buyerConcentration: n >= 10 && topShare > 0.3 ? "high" : null,
  };
}

const WINDOW_MS: Record<StatsWindow, number | null> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };

export async function recomputeReviewGroup(env: Env, g: { network: string; miner: string; model: string }, now = Date.now()) {
  const s = shrinkageFrom(env);
  const { results } = await env.DB.prepare(
    `SELECT scores_json, delivered, paid_flop, paid_verified, latency_ms, submitted_at, buyer FROM reviews
      WHERE network = ?1 AND miner = ?2 AND model = ?3 AND counted = 1 AND is_sample = 0
      ORDER BY submitted_at DESC LIMIT 20000`,
  )
    .bind(g.network, g.miner, g.model)
    .all<ReviewRow>();
  const stmts: D1PreparedStatement[] = [];
  for (const w of WINDOWS) {
    const span = WINDOW_MS[w];
    const cutoff = span === null ? null : new Date(now - span).toISOString();
    const rows = cutoff === null ? results : results.filter((r) => r.submitted_at >= cutoff);
    if (!rows.length) {
      stmts.push(env.DB.prepare("DELETE FROM miner_review_stats WHERE network = ? AND miner = ? AND model = ? AND window = ?").bind(g.network, g.miner, g.model, w));
      continue;
    }
    const st = computeReviewStats(rows, s);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO miner_review_stats (network, miner, model, window, n, n_delivered, delivery_rate, quality_avg, latency_avg,
           cost_avg, delivery_avg, quality_median, buyer_score, paid_flop_per_useful_median, latency_p50, latency_p95,
           last_reviewed_at, buyer_concentration, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (network, miner, model, window) DO UPDATE SET
           n=excluded.n, n_delivered=excluded.n_delivered, delivery_rate=excluded.delivery_rate, quality_avg=excluded.quality_avg,
           latency_avg=excluded.latency_avg, cost_avg=excluded.cost_avg, delivery_avg=excluded.delivery_avg,
           quality_median=excluded.quality_median, buyer_score=excluded.buyer_score,
           paid_flop_per_useful_median=excluded.paid_flop_per_useful_median, latency_p50=excluded.latency_p50,
           latency_p95=excluded.latency_p95, last_reviewed_at=excluded.last_reviewed_at,
           buyer_concentration=excluded.buyer_concentration, computed_at=excluded.computed_at`,
      ).bind(
        g.network, g.miner, g.model, w, st.n, st.nDelivered, st.deliveryRate, st.qualityAvg, st.latencyAvg, st.costAvg, st.deliveryAvg,
        st.qualityMedian, st.buyerScore, st.paidFlopPerUsefulMedian, st.latencyMsP50, st.latencyMsP95, st.lastReviewedAt,
        st.buyerConcentration, now,
      ),
    );
  }
  await env.DB.batch(stmts);
}

export async function recomputeAllReviews(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare("SELECT DISTINCT network, miner, model FROM reviews WHERE counted = 1 AND is_sample = 0").all<{
    network: string; miner: string; model: string;
  }>();
  await env.DB.prepare("DELETE FROM miner_review_stats").run();
  for (const g of results) await recomputeReviewGroup(env, g, now);
  return results.length;
}
