import type { Env } from "../env";
import { intVar } from "../env";
import { getVerifier, type VerifyOutcome } from "../verify";
import type { ReceiptPayload } from "./schema";
import { hasLiveCounted, recomputeAll, recomputeGroup, setMeta, showingSamples } from "../stats/aggregate";
import { ratingCapReason, recomputeReviewGroup } from "../reviews/aggregate";

export interface ReceiptState {
  id: string;
  verification: "pending_verification" | "passed" | "failed";
  verificationNote: string | null;
  counted: boolean;
  excludedReason: string | null;
}

/** Self-dealing rules (SPEC §4). Returns an exclusion reason or null. */
export async function selfDealingReason(env: Env, p: Pick<ReceiptPayload, "did" | "buyer" | "miner" | "network">): Promise<string | null> {
  if (p.buyer === p.miner) return "self_dealing:buyer_is_miner";
  const r = await env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM bindings WHERE did = ?1 AND wallet = ?2 AND network = ?4) AS did_owns_miner,
       EXISTS (SELECT 1 FROM bindings a JOIN bindings b ON a.did = b.did AND a.network = b.network
                WHERE a.wallet = ?3 AND b.wallet = ?2 AND a.network = ?4) AS shared_owner`,
  )
    .bind(p.did, p.miner, p.buyer, p.network)
    .first<{ did_owns_miner: number; shared_owner: number }>();
  if (r?.did_owns_miner) return "self_dealing:submitter_bound_to_miner";
  if (r?.shared_owner) return "self_dealing:buyer_and_miner_bound_to_same_did";
  return null;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, ctrl: AbortController): Promise<T | VerifyOutcome> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<VerifyOutcome>((resolve) => {
    t = setTimeout(() => {
      ctrl.abort();
      resolve({ outcome: "unavailable", note: "verify_timeout" });
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run chain verification for a stored receipt and persist the result.
 * `mode: inline` uses a short timeout; the queue consumer uses a longer one.
 */
export async function runVerification(
  env: Env,
  id: string,
  payload: ReceiptPayload,
  excludedReason: string | null,
  mode: "inline" | "queue",
): Promise<ReceiptState> {
  const verifier = getVerifier(env);
  const ctrl = new AbortController();
  const ms = mode === "inline" ? intVar(env.VERIFY_INLINE_TIMEOUT_MS, 2500) : 20_000;
  const res = (await withTimeout(verifier.verify(payload, ctrl.signal), ms, ctrl)) as VerifyOutcome;
  const now = Date.now();

  if (res.outcome === "unavailable") {
    await env.DB.prepare(
      "UPDATE receipts SET verify_attempts = verify_attempts + 1, verification_note = ? WHERE id = ? AND verification = 'pending_verification'",
    )
      .bind(res.note, id)
      .run();
    return { id, verification: "pending_verification", verificationNote: res.note, counted: false, excludedReason };
  }

  const passed = res.outcome === "passed";
  const counted = passed && excludedReason === null;
  const wasLive = counted && payload.network === "testnet" ? await hasLiveCounted(env) : true;
  await env.DB.prepare(
    `UPDATE receipts SET verification = ?, verification_note = ?, verified_at = ?, verified_by = ?, counted = ?,
            verify_attempts = verify_attempts + 1
      WHERE id = ? AND verification = 'pending_verification'`,
  )
    .bind(passed ? "passed" : "failed", res.note ?? null, now, verifier.name, counted ? 1 : 0, id)
    .run();

  if (counted && payload.review) {
    const capped = await ratingCapReason(env, { id, network: payload.network, buyer: payload.buyer, submittedAt: payload.submittedAt });
    if (capped) await env.DB.prepare("UPDATE receipts SET review_excluded = ? WHERE id = ?").bind(capped, id).run();
  }
  if (counted) {
    if (!wasLive) {
      // First real counted testnet receipt: drop SAMPLE rows from all aggregates.
      await recomputeAll(env);
    } else {
      const samples = await showingSamples(env);
      await recomputeGroup(env, payload, samples);
      await recomputeReviewGroup(env, payload, samples);
      await setMeta(env, "stats_built_at", new Date(now).toISOString());
    }
  }
  return {
    id,
    verification: passed ? "passed" : "failed",
    verificationNote: res.note ?? null,
    counted,
    excludedReason,
  };
}
