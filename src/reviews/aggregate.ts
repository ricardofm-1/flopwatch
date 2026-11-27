import type { Env } from "../env";
import { intVar } from "../env";
import { median, WINDOWS, type StatsWindow } from "../stats/aggregate";

/**
 * Buyer-rating aggregates. Every receipt carries a mandatory 1–5 rating (0.5 steps); a rating counts when its
 * receipt counts (verified on chain, not self-dealing) and the buyer is under the 7-day cap.
 */
export interface RatingRow {
  rating: number;
  ok: number;
  paid_flop: string | null;
  submitted_at: string;
  buyer: string;
  is_sample?: number;
}

export interface RatingStats {
  n: number;
  ratingAvg: number | null;
  ratingMedian: number | null;
  nDelivered: number;
  deliveryRate: number | null;
  paidFlopPerUsefulMedian: number | null;
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

/** Bayesian (shrunk) mean: (m·prior + Σrating) / (m + n). */
export function shrunkMean(values: number[], s: Shrinkage): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return (s.m * s.prior + sum) / (s.m + values.length);
}

export const MIN_PAID_FOR_MEDIAN = 3;
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

export function computeRatingStats(rows: RatingRow[], s: Shrinkage): RatingStats {
  const n = rows.length;
  const ratings = rows.map((r) => r.rating);
  const nDelivered = rows.filter((r) => r.ok === 1).length;
  // "Useful" = the session delivered (ok: inference returned and settled).
  const paidUseful = rows.filter((r) => r.ok === 1 && r.paid_flop !== null).map((r) => Number(r.paid_flop)).filter(Number.isFinite);
  const perBuyer = new Map<string, number>();
  for (const r of rows) perBuyer.set(r.buyer, (perBuyer.get(r.buyer) ?? 0) + 1);
  const topShare = n ? Math.max(...perBuyer.values()) / n : 0;
  let last: string | null = null;
  for (const r of rows) if (!last || r.submitted_at > last) last = r.submitted_at;
  return {
    n,
    ratingAvg: n ? r2(shrunkMean(ratings, s)) : null,
    ratingMedian: median(ratings),
    nDelivered,
    deliveryRate: n ? Math.round((nDelivered / n) * 1e4) / 1e4 : null,
    paidFlopPerUsefulMedian: paidUseful.length >= MIN_PAID_FOR_MEDIAN ? Number((median(paidUseful) as number).toPrecision(6)) : null,
    lastReviewedAt: last,
    buyerConcentration: n >= 10 && topShare > 0.3 ? "high" : null,
  };
}

const WINDOW_MS: Record<StatsWindow, number | null> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };

export async function recomputeReviewGroup(
  env: Env,
  g: { network: string; miner: string; model: string },
  includeSamples: boolean,
  now = Date.now(),
): Promise<void> {
  const s = shrinkageFrom(env);
  const { results } = await env.DB.prepare(
    `SELECT rating, ok, paid_flop, submitted_at, buyer, is_sample FROM receipts
      WHERE network = ?1 AND miner = ?2 AND model = ?3 AND counted = 1 AND rating IS NOT NULL AND review_excluded IS NULL
        AND (is_sample = 0 OR ?4 = 1)
      ORDER BY submitted_at DESC LIMIT 20000`,
  )
    .bind(g.network, g.miner, g.model, includeSamples ? 1 : 0)
    .all<RatingRow>();
  const stmts: D1PreparedStatement[] = [];
  for (const w of WINDOWS) {
    const span = WINDOW_MS[w];
    const cutoff = span === null ? null : new Date(now - span).toISOString();
    const rows = cutoff === null ? results : results.filter((r) => r.submitted_at >= cutoff);
    if (!rows.length) {
      stmts.push(env.DB.prepare("DELETE FROM miner_review_stats WHERE network = ? AND miner = ? AND model = ? AND window = ?").bind(g.network, g.miner, g.model, w));
      continue;
    }
    const st = computeRatingStats(rows, s);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO miner_review_stats (network, miner, model, window, n, rating_avg, rating_median, n_delivered, delivery_rate,
           paid_flop_per_useful_median, last_reviewed_at, buyer_concentration, is_sample, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (network, miner, model, window) DO UPDATE SET
           n=excluded.n, rating_avg=excluded.rating_avg, rating_median=excluded.rating_median, n_delivered=excluded.n_delivered,
           delivery_rate=excluded.delivery_rate, paid_flop_per_useful_median=excluded.paid_flop_per_useful_median,
           last_reviewed_at=excluded.last_reviewed_at, buyer_concentration=excluded.buyer_concentration,
           is_sample=excluded.is_sample, computed_at=excluded.computed_at`,
      ).bind(
        g.network, g.miner, g.model, w, st.n, st.ratingAvg, st.ratingMedian, st.nDelivered, st.deliveryRate,
        st.paidFlopPerUsefulMedian, st.lastReviewedAt, st.buyerConcentration, rows.every((r) => r.is_sample === 1) ? 1 : 0, now,
      ),
    );
  }
  await env.DB.batch(stmts);
}

export async function recomputeAllReviews(env: Env, includeSamples: boolean, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT network, miner, model FROM receipts
      WHERE counted = 1 AND rating IS NOT NULL AND review_excluded IS NULL AND (is_sample = 0 OR ?1 = 1)`,
  )
    .bind(includeSamples ? 1 : 0)
    .all<{ network: string; miner: string; model: string }>();
  await env.DB.prepare("DELETE FROM miner_review_stats").run();
  for (const g of results) await recomputeReviewGroup(env, g, includeSamples, now);
  return results.length;
}

/**
 * Per-buyer cap: in any 7 days only a buyer wallet's first REVIEW_MAX_PER_BUYER_7D counted ratings count.
 * Returns the exclusion reason for this receipt's rating, or null. The receipt itself still counts for reliability.
 */
export async function ratingCapReason(env: Env, r: { id: string; network: string; buyer: string; submittedAt: string }): Promise<string | null> {
  const cap = intVar(env.REVIEW_MAX_PER_BUYER_7D, 10);
  const since = new Date(Date.parse(r.submittedAt) - 7 * 86_400_000).toISOString();
  const c = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM receipts
      WHERE network = ? AND buyer = ? AND counted = 1 AND rating IS NOT NULL AND review_excluded IS NULL AND submitted_at >= ? AND id != ?`,
  ).bind(r.network, r.buyer, since, r.id).first<{ n: number }>();
  return (c?.n ?? 0) >= cap ? "buyer_review_cap" : null;
}
