import type { Env, Network } from "../env";
import { explorerLink, intVar, networkConfig } from "../env";
import { WINDOWS, type StatsWindow } from "../stats/aggregate";

/** Buyer-rating aggregates and the latest rated receipts. Buyer and DID are never exposed. */
export interface ReviewStatsRow {
  network: string;
  miner: string;
  model: string;
  window: StatsWindow;
  n: number;
  rating_avg: number | null;
  rating_median: number | null;
  n_delivered: number;
  delivery_rate: number | null;
  paid_flop_per_useful_median: number | null;
  last_reviewed_at: string | null;
  buyer_concentration: string | null;
  is_sample: number;
}

export function reviewFeedRow(env: Env, r: ReviewStatsRow) {
  const minN = intVar(env.REVIEW_MIN_N, 5);
  const net = networkConfig(env, r.network as Network);
  return {
    network: r.network,
    miner: r.miner,
    model: r.model,
    window: r.window,
    n: r.n,
    lowSample: r.n < 5,
    ranked: r.n >= minN,
    sample: r.is_sample === 1,
    rating: r.rating_avg,
    ratingMedian: r.rating_median,
    nDelivered: r.n_delivered,
    deliveryRate: r.delivery_rate,
    paidFlopPerUsefulMedian: r.paid_flop_per_useful_median,
    lastReviewedAt: r.last_reviewed_at,
    buyerConcentration: r.buyer_concentration,
    flopscanAccount: explorerLink(net.accountUrl, "address", r.miner),
  };
}

export async function reviewStatsRows(env: Env, f: { network?: string; window?: string; miner?: string; hideSamples: boolean }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM miner_review_stats
      WHERE (?1 IS NULL OR network = ?1) AND (?2 IS NULL OR window = ?2) AND (?3 IS NULL OR miner = ?3) AND (?4 = 0 OR is_sample = 0)
      ORDER BY rating_avg DESC, n DESC`,
  )
    .bind(f.network ?? null, f.window ?? null, f.miner ?? null, f.hideSamples ? 1 : 0)
    .all<ReviewStatsRow>();
  return results;
}

export async function reviewCounts(env: Env) {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN counted = 1 AND is_sample = 0 AND network = 'testnet' AND rating IS NOT NULL AND review_excluded IS NULL
                 AND verified_by IS NOT NULL AND verified_by != 'mock' THEN 1 ELSE 0 END) AS counted_live,
       SUM(CASE WHEN verification = 'pending_verification' AND rating IS NOT NULL THEN 1 ELSE 0 END) AS pending
     FROM receipts`,
  ).first<{ counted_live: number | null; pending: number | null }>();
  return { countedLiveReviews: r?.counted_live ?? 0, pendingReviews: r?.pending ?? 0 };
}

export async function buildReviewsFeed(env: Env, opts: { network?: string; window?: string; hideSamples: boolean; dataLabel: string }) {
  const window = (WINDOWS as readonly string[]).includes(opts.window ?? "") ? opts.window : "all";
  const network = opts.network === "devnet" ? "devnet" : "testnet";
  const rows = await reviewStatsRows(env, { network, window, hideSamples: opts.hideSamples });
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    dataLabel: opts.dataLabel,
    network,
    window,
    minNForRanking: intVar(env.REVIEW_MIN_N, 5),
    notice: "Buyer ratings (1–5 stars) submitted with verified paid receipts. Independent; not an official FLOP Network ranking. Official chain-side reliability: FLOPScan.",
    flopscanMarkets: networkConfig(env, network).marketsUrl || null,
    miners: rows.map((r) => reviewFeedRow(env, r)),
  };
}

/** The `reviews` block in /feeds/miners/:ss58.json. Latest ratings come from the receipts list itself. */
export async function minerReviews(env: Env, miner: string, network: string | undefined, hideSamples: boolean) {
  const stats = await reviewStatsRows(env, { network, miner, hideSamples });
  return { stats: stats.map((r) => reviewFeedRow(env, r)) };
}
