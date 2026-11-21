import type { Env } from "../env";
import { HttpError } from "./http";

export interface Limit {
  key: string;
  windowSeconds: number;
  max: number;
}

/**
 * Fixed-window counters in D1 (KV is not for counters: 1k writes/day on Free).
 * Increments all keys in one batch, then throws 429 if any exceeded.
 */
export async function enforceRateLimits(env: Env, limits: Limit[], now = Date.now()): Promise<void> {
  if (limits.length === 0) return;
  const stmts = limits.map((l) => {
    const windowStart = Math.floor(now / 1000 / l.windowSeconds) * l.windowSeconds;
    return env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(l.key, windowStart);
  });
  const results = await env.DB.batch<{ count: number }>(stmts);
  for (let i = 0; i < limits.length; i++) {
    const l = limits[i]!;
    const count = results[i]?.results[0]?.count ?? 0;
    if (count > l.max) {
      const windowStart = Math.floor(now / 1000 / l.windowSeconds) * l.windowSeconds;
      const retryAfter = windowStart + l.windowSeconds - Math.floor(now / 1000);
      throw new HttpError(429, "rate_limited", `rate limit exceeded: ${l.key.split(":").slice(0, 2).join(":")}`, {
        retryAfter,
      });
    }
  }
}

export async function pruneRateLimits(env: Env, now = Date.now()): Promise<void> {
  // Daily windows are the longest we use; keep two days.
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(now / 1000) - 2 * 86400).run();
}
