import type { Env, Network } from "../env";

export const WINDOWS = ["7d", "30d", "all"] as const;
export type StatsWindow = (typeof WINDOWS)[number];
const WINDOW_MS: Record<StatsWindow, number | null> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };

export interface ReceiptRow {
  status: string;
  ok: number;
  latency_ms: number | null;
  paid_flop: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error_class: string | null;
  channel_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface MinerStats {
  n: number;
  successRate: number | null;
  settlementRate: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  priceSessionMedian: number | null;
  priceTokenMedian: number | null;
  lastSeen: string | null;
}

/** Nearest-rank percentile on a sorted copy. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(Math.max(rank, 1), s.length) - 1]!;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rates to 4 dp; latencies to 0.1 ms; FLOP amounts to 6 significant digits (no float noise like 0.0042675000000000005). */
export const roundRate = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
export const roundMs = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
export const roundFlop = (x: number | null) => (x === null ? null : Number(x.toPrecision(6)));

/** SPEC §7 aggregation over already-counted (verified, not excluded) receipts. */
export function computeStats(rows: ReceiptRow[]): MinerStats {
  const decided = rows.filter((r) => r.status !== "pending");
  const successes = decided.filter((r) => r.ok === 1 && r.status === "settled").length;

  const settled = rows.filter((r) => r.status === "settled").length;
  const challenged = rows.filter((r) => r.status === "challenged").length;
  const settlementFailed = rows.filter((r) => r.status === "failed" && r.error_class === "settlement").length;
  // "timeout after accept": a channel was opened, so the miner accepted the session.
  const timeoutAfterAccept = rows.filter((r) => r.status === "timeout" && r.channel_id !== null).length;
  const settleDenom = settled + challenged + settlementFailed + timeoutAfterAccept;

  const latencies = rows.map((r) => r.latency_ms).filter((x): x is number => typeof x === "number");
  const prices = rows
    .filter((r) => r.status === "settled" && r.paid_flop !== null)
    .map((r) => Number(r.paid_flop))
    .filter(Number.isFinite);
  const perToken = rows
    .filter((r) => r.status === "settled" && r.paid_flop !== null && r.prompt_tokens !== null && r.completion_tokens !== null)
    .map((r) => {
      const t = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
      return t > 0 ? Number(r.paid_flop) / t : NaN;
    })
    .filter(Number.isFinite);
  let lastSeen: string | null = null;
  for (const r of rows) {
    const t = r.finished_at ?? r.started_at;
    if (!lastSeen || t > lastSeen) lastSeen = t;
  }
  return {
    n: rows.length,
    successRate: roundRate(decided.length ? successes / decided.length : null),
    settlementRate: roundRate(settleDenom ? settled / settleDenom : null),
    latencyP50: roundMs(percentile(latencies, 50)),
    latencyP95: roundMs(percentile(latencies, 95)),
    priceSessionMedian: roundFlop(median(prices)),
    priceTokenMedian: roundFlop(median(perToken)),
    lastSeen,
  };
}

/** A real counted testnet receipt exists (mock-verified rows never qualify). */
export async function hasLiveCounted(env: Env): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 AS x FROM receipts
      WHERE network = 'testnet' AND counted = 1 AND is_sample = 0 AND verified_by IS NOT NULL AND verified_by != 'mock'
      LIMIT 1`,
  ).first();
  return !!r;
}

const MAX_ROWS_PER_GROUP = 20_000;

/** Recompute and upsert miner_stats for one (network, miner, model) across all windows. */
export async function recomputeGroup(
  env: Env,
  g: { network: Network | string; miner: string; model: string },
  includeSamples: boolean,
  now = Date.now(),
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT status, ok, latency_ms, paid_flop, prompt_tokens, completion_tokens, error_class, channel_id,
            started_at, finished_at, is_sample
       FROM receipts
      WHERE network = ?1 AND miner = ?2 AND model = ?3 AND counted = 1 AND (is_sample = 0 OR ?4 = 1)
      ORDER BY started_at DESC LIMIT ${MAX_ROWS_PER_GROUP}`,
  )
    .bind(g.network, g.miner, g.model, includeSamples ? 1 : 0)
    .all<ReceiptRow & { is_sample: number }>();

  const stmts: D1PreparedStatement[] = [];
  for (const w of WINDOWS) {
    const span = WINDOW_MS[w];
    const cutoff = span === null ? null : new Date(now - span).toISOString();
    const rows = cutoff === null ? results : results.filter((r) => r.started_at >= cutoff);
    if (rows.length === 0) {
      stmts.push(
        env.DB.prepare("DELETE FROM miner_stats WHERE network = ? AND miner = ? AND model = ? AND window = ?").bind(
          g.network, g.miner, g.model, w,
        ),
      );
      continue;
    }
    const s = computeStats(rows);
    const allSample = rows.every((r) => r.is_sample === 1) ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO miner_stats (network, miner, model, window, is_sample, n, success_rate, settlement_rate,
                                  latency_p50, latency_p95, price_session_median, price_token_median, last_seen, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (network, miner, model, window) DO UPDATE SET
           is_sample=excluded.is_sample, n=excluded.n, success_rate=excluded.success_rate,
           settlement_rate=excluded.settlement_rate, latency_p50=excluded.latency_p50, latency_p95=excluded.latency_p95,
           price_session_median=excluded.price_session_median, price_token_median=excluded.price_token_median,
           last_seen=excluded.last_seen, computed_at=excluded.computed_at`,
      ).bind(
        g.network, g.miner, g.model, w, allSample, s.n, s.successRate, s.settlementRate, s.latencyP50, s.latencyP95,
        s.priceSessionMedian, s.priceTokenMedian, s.lastSeen, now,
      ),
    );
  }
  await env.DB.batch(stmts);
}

/** Full rebuild (daily cron, after seeding, or when the first live receipt lands). */
export async function recomputeAll(env: Env, now = Date.now()): Promise<number> {
  const includeSamples = !(await hasLiveCounted(env));
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT network, miner, model FROM receipts WHERE counted = 1 AND (is_sample = 0 OR ?1 = 1)`,
  )
    .bind(includeSamples ? 1 : 0)
    .all<{ network: string; miner: string; model: string }>();
  await env.DB.prepare("DELETE FROM miner_stats").run();
  for (const g of results) await recomputeGroup(env, g, includeSamples, now);
  await setMeta(env, "stats_built_at", new Date(now).toISOString());
  await env.DB.prepare("DELETE FROM meta WHERE key = 'stats_dirty'").run();
  return results.length;
}

/** Rebuild lazily if something (e.g. the seed script) marked stats dirty. */
export async function ensureStatsFresh(env: Env): Promise<void> {
  const dirty = await env.DB.prepare("SELECT value FROM meta WHERE key = 'stats_dirty'").first();
  if (dirty) await recomputeAll(env);
}

export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
