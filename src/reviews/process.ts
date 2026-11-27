import type { Env } from "../env";
import { intVar } from "../env";
import { getVerifier, type ChainVerifier } from "../verify";
import { flopToPlanck, type SessionCheck } from "../verify/rpc";
import { withTimeout } from "../receipts/process";
import { recomputeReviewGroup } from "./aggregate";
import type { ReviewPayload } from "./schema";

export interface ReviewState {
  id: string;
  verification: "pending_verification" | "passed" | "failed";
  verificationNote: string | null;
  counted: boolean;
  excludedReason: string | null;
  paidVerified: boolean;
}

/**
 * FLOPWATCH-BUYER-REVIEWS-SPEC §7.4 + §8.3. Decides one stored review against the chain.
 * Pending while the RPC is unavailable or the channel isn't Closed yet; failed on a mismatch;
 * otherwise passed, and counted unless an exclusion applies.
 */
export async function decideReview(
  env: Env,
  id: string,
  p: ReviewPayload,
  selfDealing: string | null,
  mode: "inline" | "queue",
  verifierOverride?: ChainVerifier,
  now = Date.now(),
): Promise<ReviewState> {
  const verifier = verifierOverride ?? getVerifier(env);
  const ctrl = new AbortController();
  const ms = mode === "inline" ? intVar(env.VERIFY_INLINE_TIMEOUT_MS, 2500) : 20_000;
  const res = (await withTimeout(
    verifier.checkSession(
      {
        network: p.network, buyer: p.buyer, miner: p.miner, modelHash: p.modelHash ?? null, channelId: p.channelId,
        settlementTx: p.settlementTx ?? null, blockNumber: p.blockNumber ?? null, maxFlop: p.maxFlop ?? null, paidFlop: p.paidFlop ?? null,
      },
      ctrl.signal,
    ),
    ms,
    ctrl,
  )) as SessionCheck;

  const pending = async (note: string): Promise<ReviewState> => {
    await env.DB.prepare(
      "UPDATE reviews SET verify_attempts = verify_attempts + 1, verification_note = ? WHERE id = ? AND verification = 'pending_verification'",
    ).bind(note, id).run();
    return { id, verification: "pending_verification", verificationNote: note, counted: false, excludedReason: selfDealing, paidVerified: false };
  };
  const finish = async (passed: boolean, note: string, excluded: string | null, paidVerified: boolean): Promise<ReviewState> => {
    const counted = passed && excluded === null;
    await env.DB.prepare(
      `UPDATE reviews SET verification = ?, verification_note = ?, verified_at = ?, verified_by = ?, excluded_reason = ?,
              paid_verified = ?, counted = ?, verify_attempts = verify_attempts + 1
        WHERE id = ? AND verification = 'pending_verification'`,
    ).bind(passed ? "passed" : "failed", note, now, verifier.name, excluded, paidVerified ? 1 : 0, counted ? 1 : 0, id).run();
    if (counted) await recomputeReviewGroup(env, p, now);
    return { id, verification: passed ? "passed" : "failed", verificationNote: note, counted, excludedReason: excluded, paidVerified };
  };

  if (res.outcome === "unavailable") return pending(res.note);
  if (res.outcome === "failed") return finish(false, res.note, selfDealing, false);

  // SettlementPostedResult / still settling: store, don't count, re-check later.
  if (res.state !== "Closed") return pending(`channel_not_closed_yet:${res.state}`);

  const freshnessDays = intVar(env.REVIEW_FRESHNESS_DAYS, 30);
  if (Date.parse(p.submittedAt) - res.openedAtMs > freshnessDays * 86_400_000) {
    return finish(false, `review_too_late:>${freshnessDays}d_after_session`, selfDealing, false);
  }

  const notes = [res.note];
  // paidFlop equality: only against a counted FlopWatch receipt for the same channel (minerPaid lives on the
  // Settled event, which this lean path doesn't decode). Otherwise keep it, flagged paid_unverified.
  let paidVerified = false;
  let paidMismatch = false;
  if (p.paidFlop != null) {
    const rec = await env.DB.prepare(
      "SELECT paid_flop FROM receipts WHERE network = ? AND channel_id = ? AND counted = 1 AND paid_flop IS NOT NULL LIMIT 1",
    ).bind(p.network, p.channelId.toLowerCase()).first<{ paid_flop: string }>();
    if (rec) {
      const a = flopToPlanck(p.paidFlop);
      const b = flopToPlanck(rec.paid_flop);
      paidVerified = a !== null && a === b;
      paidMismatch = !paidVerified;
    } else notes.push("paid_unverified");
  }

  let excluded = selfDealing;
  if (!excluded && !p.settlementTx) excluded = "no_settlement_tx";
  if (!excluded && paidMismatch) excluded = "paid_flop_mismatch";
  if (!excluded) {
    const cap = intVar(env.REVIEW_MAX_PER_BUYER_7D, 10);
    const since = new Date(Date.parse(p.submittedAt) - 7 * 86_400_000).toISOString();
    const c = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reviews WHERE network = ? AND buyer = ? AND counted = 1 AND submitted_at >= ? AND id != ?`,
    ).bind(p.network, p.buyer, since, id).first<{ n: number }>();
    if ((c?.n ?? 0) >= cap) excluded = "buyer_review_cap";
  }
  return finish(true, notes.join("; "), excluded, paidVerified);
}
