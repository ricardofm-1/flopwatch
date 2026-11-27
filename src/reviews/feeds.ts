import type { Env, Network } from "../env";
import { explorerLink, intVar, networkConfig } from "../env";
import { WINDOWS, type StatsWindow } from "../stats/aggregate";
import type { Scores } from "./schema";

/** Public review JSON: never buyer, never DID, never wallet signature (FLOPWATCH-BUYER-REVIEWS-SPEC §7.1). */
export function publicReview(env: Env, r: Record<string, unknown>) {
  let scores: Scores | null = null;
  try {
    scores = JSON.parse(String(r.scores_json)) as Scores;
  } catch {
    scores = null;
  }
  const net = networkConfig(env, r.network as Network);
  return {
    id: r.id,
    network: r.network,
    miner: r.miner,
    model: r.model,
    modelHash: r.model_hash ?? null,
    channelId: r.channel_id,
    settlementTx: r.settlement_tx ?? null,
    settlementTxUrl: explorerLink(net.txUrl, "hash", r.settlement_tx as string | null),
    scores,
    delivered: r.delivered === 1,
    promptCategory: r.prompt_category ?? null,
    latencyMs: r.latency_ms ?? null,
    paidFlop: r.paid_flop ?? null,
    paidVerified: r.paid_verified === 1,
    notes: r.notes ?? null,
    submittedAt: r.submitted_at,
    verification: r.verification,
    verificationNote: r.verification_note ?? null,
    counted: r.counted === 1,
    excludedReason: r.excluded_reason ?? null,
  };
}

const REVIEW_COLS = `id, network, miner, model, model_hash, channel_id, settlement_tx, scores_json, delivered, prompt_category,
  latency_ms, paid_flop, paid_verified, notes, submitted_at, verification, verification_note, counted, excluded_reason`;

export async function getPublicReview(env: Env, id: string) {
  const r = await env.DB.prepare(`SELECT ${REVIEW_COLS} FROM reviews WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return r ? publicReview(env, r) : null;
}

export interface ReviewStatsRow {
  network: string;
  miner: string;
  model: string;
  window: StatsWindow;
  n: number;
  n_delivered: number;
  delivery_rate: number | null;
  quality_avg: number | null;
  latency_avg: number | null;
  cost_avg: number | null;
  delivery_avg: number | null;
  quality_median: number | null;
  buyer_score: number | null;
  paid_flop_per_useful_median: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
  last_reviewed_at: string | null;
  buyer_concentration: string | null;
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
    buyerScore: r.buyer_score,
    qualityAvg: r.quality_avg,
    latencyAvg: r.latency_avg,
    costAvg: r.cost_avg,
    deliveryAvg: r.delivery_avg,
    qualityMedian: r.quality_median,
    nDelivered: r.n_delivered,
    deliveryRate: r.delivery_rate,
    paidFlopPerUsefulMedian: r.paid_flop_per_useful_median,
    latencyMsP50: r.latency_p50,
    latencyMsP95: r.latency_p95,
    lastReviewedAt: r.last_reviewed_at,
    buyerConcentration: r.buyer_concentration,
    flopscanAccount: explorerLink(net.accountUrl, "address", r.miner),
  };
}

export async function reviewStatsRows(env: Env, f: { network?: string; window?: string; miner?: string }) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM miner_review_stats WHERE (?1 IS NULL OR network = ?1) AND (?2 IS NULL OR window = ?2) AND (?3 IS NULL OR miner = ?3)
      ORDER BY buyer_score DESC, n DESC`,
  )
    .bind(f.network ?? null, f.window ?? null, f.miner ?? null)
    .all<ReviewStatsRow>();
  return results;
}

export async function reviewCounts(env: Env) {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN counted = 1 AND is_sample = 0 AND network = 'testnet' THEN 1 ELSE 0 END) AS counted_live,
       SUM(CASE WHEN verification = 'pending_verification' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN is_sample = 1 THEN 1 ELSE 0 END) AS sample
     FROM reviews`,
  ).first<{ counted_live: number | null; pending: number | null; sample: number | null }>();
  return { countedLiveReviews: r?.counted_live ?? 0, pendingReviews: r?.pending ?? 0, sampleReviews: r?.sample ?? 0 };
}

export async function buildReviewsFeed(env: Env, opts: { network?: string; window?: string }) {
  const window = (WINDOWS as readonly string[]).includes(opts.window ?? "") ? opts.window : "all";
  const network = opts.network === "devnet" ? "devnet" : "testnet";
  const rows = await reviewStatsRows(env, { network, window });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    network,
    window,
    minNForRanking: intVar(env.REVIEW_MIN_N, 5),
    notice: "Observed buyer feedback from verified paid sessions. Independent; not an official FLOP Network ranking. Official chain-side reliability: FLOPScan.",
    flopscanMarkets: networkConfig(env, network).marketsUrl || null,
    miners: rows.map((r) => reviewFeedRow(env, r)),
  };
}

/** The `reviews` block added to /feeds/miners/:ss58.json. */
export async function minerReviews(env: Env, miner: string, network?: string, latest = 20) {
  const stats = await reviewStatsRows(env, { network, miner });
  const { results } = await env.DB.prepare(
    `SELECT ${REVIEW_COLS} FROM reviews WHERE miner = ?1 AND (?2 IS NULL OR network = ?2) AND counted = 1 AND is_sample = 0
      ORDER BY submitted_at DESC LIMIT ?3`,
  )
    .bind(miner, network ?? null, latest)
    .all<Record<string, unknown>>();
  return { stats: stats.map((r) => reviewFeedRow(env, r)), latest: results.map((r) => publicReview(env, r)) };
}

export async function reviewSnapshotNdjson(env: Env, sinceMs: number): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT ${REVIEW_COLS} FROM reviews WHERE received_at >= ? AND counted = 1 AND is_sample = 0 ORDER BY received_at`,
  )
    .bind(sinceMs)
    .all<Record<string, unknown>>();
  return results.map((r) => JSON.stringify(publicReview(env, r))).join("\n");
}
