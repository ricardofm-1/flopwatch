import type { Env, Network } from "../env";
import { explorerLink, networkConfig, NETWORKS } from "../env";
import { minerReviews, reviewCounts, reviewSnapshotNdjson } from "../reviews/feeds";
import { ensureStatsFresh, getMeta, hasLiveCounted, roundFlop, roundMs, roundRate, WINDOWS, type StatsWindow } from "./aggregate";

export const SCHEMA_VERSION = 1;

export interface MinerFeedRow {
  network: string;
  miner: string;
  model: string;
  window: StatsWindow;
  sample: boolean;
  n: number;
  lowSample: boolean;
  successRate: number | null;
  settlementRate: number | null;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  flopPerSessionMedian: number | null;
  flopPerTokenMedian: number | null;
  lastSeen: string | null;
  explorer: string | null;
}

interface StatsRow {
  network: string;
  miner: string;
  model: string;
  window: StatsWindow;
  is_sample: number;
  n: number;
  success_rate: number | null;
  settlement_rate: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
  price_session_median: number | null;
  price_token_median: number | null;
  last_seen: string | null;
}

function toFeedRow(env: Env, r: StatsRow): MinerFeedRow {
  return {
    network: r.network,
    miner: r.miner,
    model: r.model,
    window: r.window,
    sample: r.is_sample === 1,
    n: r.n,
    lowSample: r.n < 5,
    // Rounded again here so rows computed before rounding existed are clean too.
    successRate: roundRate(r.success_rate),
    settlementRate: roundRate(r.settlement_rate),
    latencyMsP50: roundMs(r.latency_p50),
    latencyMsP95: roundMs(r.latency_p95),
    flopPerSessionMedian: roundFlop(r.price_session_median),
    flopPerTokenMedian: roundFlop(r.price_token_median),
    lastSeen: r.last_seen,
    explorer: explorerLink(networkConfig(env, r.network as Network).accountUrl, "address", r.miner),
  };
}

export async function buildMeta(env: Env) {
  await ensureStatsFresh(env);
  const live = await hasLiveCounted(env);
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN counted = 1 AND is_sample = 0 AND verified_by IS NOT NULL AND verified_by != 'mock' THEN 1 ELSE 0 END) AS counted_live,
       SUM(CASE WHEN is_sample = 1 THEN 1 ELSE 0 END) AS sample_rows,
       SUM(CASE WHEN verification = 'pending_verification' THEN 1 ELSE 0 END) AS pending
     FROM receipts`,
  ).first<{ counted_live: number | null; sample_rows: number | null; pending: number | null }>();
  return {
    schemaVersion: SCHEMA_VERSION,
    dataLabel: live ? "LIVE TESTNET DATA" : "SAMPLE — NOT LIVE DATA",
    live,
    defaultNetwork: "testnet" as Network,
    networks: NETWORKS,
    windows: WINDOWS,
    statsBuiltAt: await getMeta(env, "stats_built_at"),
    countedLiveReceipts: counts?.counted_live ?? 0,
    sampleReceipts: counts?.sample_rows ?? 0,
    pendingVerification: counts?.pending ?? 0,
    ...(await reviewCounts(env)),
    site: "Flopwatch",
    notice: "Observed, verified receipts. Independent; not an official FLOP Network ranking.",
  };
}

export async function buildMinersFeed(env: Env, opts: { network?: string } = {}) {
  const meta = await buildMeta(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM miner_stats WHERE (?1 IS NULL OR network = ?1) AND (?2 = 0 OR is_sample = 0)
      ORDER BY network, window, n DESC`,
  )
    .bind(opts.network ?? null, meta.live ? 1 : 0)
    .all<StatsRow>();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataLabel: meta.dataLabel,
    statsBuiltAt: meta.statsBuiltAt,
    miners: results.map((r) => toFeedRow(env, r)),
  };
}

/** Public per-receipt view. Buyer and submitter DID are always redacted. */
export function publicReceipt(env: Env, r: Record<string, unknown>) {
  const net = networkConfig(env, r.network as Network);
  return {
    id: r.id,
    network: r.network,
    miner: r.miner,
    model: r.model,
    modelHash: r.model_hash ?? null,
    status: r.status,
    ok: r.ok === 1,
    latencyMs: r.latency_ms ?? null,
    maxFlop: r.max_flop,
    paidFlop: r.paid_flop ?? null,
    promptTokens: r.prompt_tokens ?? null,
    completionTokens: r.completion_tokens ?? null,
    errorClass: r.error_class ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    channelId: r.channel_id ?? null,
    settlementTx: r.settlement_tx ?? null,
    blockNumber: r.block_number ?? null,
    settlementTxUrl: explorerLink(net.txUrl, "hash", r.settlement_tx as string | null),
    verification: r.verification,
    verificationNote: r.verification_note ?? null,
    counted: r.counted === 1,
    excludedReason: r.excluded_reason ?? null,
    sample: r.is_sample === 1,
  };
}

const RECEIPT_COLS = `id, network, miner, model, model_hash, status, ok, latency_ms, max_flop, paid_flop, prompt_tokens,
  completion_tokens, error_class, started_at, finished_at, channel_id, settlement_tx, block_number, verification,
  verification_note, counted, excluded_reason, is_sample`;

export async function buildMinerFeed(
  env: Env,
  miner: string,
  opts: { network?: string; limit?: number; meta?: Awaited<ReturnType<typeof buildMeta>> } = {},
) {
  const meta = opts.meta ?? (await buildMeta(env));
  const [stats, receipts] = await Promise.all([
    env.DB.prepare(
    `SELECT * FROM miner_stats WHERE miner = ?1 AND (?2 IS NULL OR network = ?2) AND (?3 = 0 OR is_sample = 0)
      ORDER BY network, model, window`,
  )
    .bind(miner, opts.network ?? null, meta.live ? 1 : 0)
    .all<StatsRow>(),
    env.DB.prepare(
    `SELECT ${RECEIPT_COLS} FROM receipts WHERE miner = ?1 AND (?2 IS NULL OR network = ?2) AND (?3 = 0 OR is_sample = 0)
      ORDER BY started_at DESC LIMIT ?4`,
  )
    .bind(miner, opts.network ?? null, meta.live ? 1 : 0, Math.min(opts.limit ?? 200, 500))
    .all<Record<string, unknown>>(),
  ]);
  if (stats.results.length === 0 && receipts.results.length === 0) {
    // A miner can have reviews without receipts.
    const any = await env.DB.prepare("SELECT 1 AS x FROM reviews WHERE miner = ? AND counted = 1 LIMIT 1").bind(miner).first();
    if (!any) return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataLabel: meta.dataLabel,
    miner,
    stats: stats.results.map((r) => toFeedRow(env, r)),
    receipts: receipts.results.map((r) => publicReceipt(env, r)),
    reviews: await minerReviews(env, miner, opts.network),
  };
}

export async function getPublicReceipt(env: Env, id: string) {
  const r = await env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM receipts WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return r ? publicReceipt(env, r) : null;
}

/** Daily public snapshot to R2 (auditor copy; redacted like the feeds). */
export async function writeSnapshot(env: Env, now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const miners = await buildMinersFeed(env);
  const meta = await buildMeta(env);
  const since = new Date(now.getTime() - 86_400_000).getTime();
  const { results } = await env.DB.prepare(
    `SELECT ${RECEIPT_COLS} FROM receipts WHERE received_at >= ? AND is_sample = 0 ORDER BY received_at`,
  )
    .bind(since)
    .all<Record<string, unknown>>();
  const ndjson = results.map((r) => JSON.stringify(publicReceipt(env, r))).join("\n");
  const json = { httpMetadata: { contentType: "application/json" } };
  await Promise.all([
    env.BUCKET.put(`snapshots/${day}/miners.json`, JSON.stringify(miners), json),
    env.BUCKET.put(`snapshots/${day}/receipts.ndjson`, ndjson, { httpMetadata: { contentType: "application/x-ndjson" } }),
    env.BUCKET.put(`snapshots/${day}/reviews.ndjson`, await reviewSnapshotNdjson(env, since), { httpMetadata: { contentType: "application/x-ndjson" } }),
    env.BUCKET.put(`data/miners.json`, JSON.stringify(miners), json),
    env.BUCKET.put(`data/index.json`, JSON.stringify({ ...meta, latestSnapshot: `snapshots/${day}/`, generatedAt: now.toISOString() }), json),
    env.BUCKET.put(`data/meta.json`, JSON.stringify({ ...meta, generatedAt: now.toISOString() }), json),
  ]);
  return day;
}
