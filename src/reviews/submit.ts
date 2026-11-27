import type { Env } from "../env";
import { intVar } from "../env";
import { HttpError, isPlainObject } from "../lib/http";
import { base64urlDecode, sha256Hex } from "../lib/encoding";
import { verifyDidSignature } from "../did/didkey";
import { verifyWalletSignature } from "../did/sr25519";
import { enforceRateLimits } from "../lib/ratelimit";
import { getVerifier, VerifierConfigError, type ChainVerifier } from "../verify";
import { jcs, jcsBytes } from "../receipts/jcs";
import { selfDealingReason } from "../receipts/process";
import { checkSubmittedAt, validateReviewPayload } from "./schema";
import { decideReview, type ReviewState } from "./process";

export interface ReviewSubmitResult {
  httpStatus: 201 | 202;
  body: ReviewState & { status: string; buyerProof: string };
}

/** POST /v1/reviews (FLOPWATCH-BUYER-REVIEWS-SPEC §7). */
export async function submitReview(
  env: Env,
  ctx: { sessionDid: string; ip: string; waitUntil?: (p: Promise<unknown>) => void; verifier?: ChainVerifier },
  envelope: unknown,
  now = Date.now(),
): Promise<ReviewSubmitResult> {
  // Same buckets as receipts (reviews can't bypass them) + a review-specific daily cap per DID.
  const hourly = intVar(env.RATE_LIMIT_SUBMIT_HOURLY, 30);
  const daily = intVar(env.RATE_LIMIT_SUBMIT_DAILY, 200);
  await enforceRateLimits(
    env,
    [
      { key: `submit:did:${ctx.sessionDid}:h`, windowSeconds: 3600, max: hourly },
      { key: `submit:did:${ctx.sessionDid}:d`, windowSeconds: 86400, max: daily },
      { key: `submit:ip:${ctx.ip}:h`, windowSeconds: 3600, max: hourly },
      { key: `submit:ip:${ctx.ip}:d`, windowSeconds: 86400, max: daily },
      { key: `review:did:${ctx.sessionDid}:d`, windowSeconds: 86400, max: intVar(env.REVIEW_MAX_PER_DID_DAILY, 20) },
    ],
    now,
  );
  let verifier: ChainVerifier;
  try {
    verifier = ctx.verifier ?? getVerifier(env);
  } catch (e) {
    if (e instanceof VerifierConfigError) throw new HttpError(503, "verifier_misconfigured", e.message);
    throw e;
  }

  if (!isPlainObject(envelope) || !isPlainObject(envelope.payload) || typeof envelope.signature !== "string") {
    throw new HttpError(400, "invalid_envelope", "expected { payload, signature, walletSignature? }");
  }
  const extra = Object.keys(envelope).filter((k) => !["payload", "signature", "walletSignature"].includes(k));
  if (extra.length) throw new HttpError(400, "invalid_envelope", `unexpected envelope fields: ${extra.join(", ")}`);
  const walletSignature = envelope.walletSignature;
  if (walletSignature !== undefined && (typeof walletSignature !== "string" || !/^(0x)?[0-9a-fA-F]{128}$/.test(walletSignature))) {
    throw new HttpError(400, "invalid_envelope", "walletSignature must be 64-byte sr25519 hex");
  }

  // 1. schema  2. did = session  3. signature
  const v = validateReviewPayload(envelope.payload);
  if (!v.ok || !v.payload) throw new HttpError(400, "invalid_review", "review failed validation", { errors: v.errors });
  const p = v.payload;
  if (p.did !== ctx.sessionDid) throw new HttpError(403, "did_mismatch", "payload.did must equal the session DID");
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(envelope.signature);
  } catch {
    throw new HttpError(400, "invalid_signature_encoding");
  }
  const canonical = jcs(p);
  if (!(await verifyDidSignature(p.did, jcsBytes(p), sig))) {
    throw new HttpError(400, "invalid_review_signature", "signature does not verify over JCS(payload)");
  }
  const future = checkSubmittedAt(p, now);
  if (future) throw new HttpError(400, "stale_review", future);

  // 4–6. nonce, id, one review per channel / settlement
  const id = await sha256Hex(canonical);
  const channelId = p.channelId.toLowerCase();
  const settlementTx = p.settlementTx ? p.settlementTx.toLowerCase() : null;
  const dup = await env.DB.prepare(
    `SELECT id, nonce, channel_id, settlement_tx FROM reviews
      WHERE id = ?1 OR nonce = ?2 OR (network = ?3 AND channel_id = ?4) OR (?5 IS NOT NULL AND network = ?3 AND settlement_tx = ?5)
      LIMIT 1`,
  ).bind(id, p.nonce, p.network, channelId, settlementTx).first<{ id: string; nonce: string; channel_id: string; settlement_tx: string | null }>();
  if (dup) {
    const why = dup.id === id ? "duplicate_review" : dup.nonce === p.nonce ? "duplicate_nonce" : dup.channel_id === channelId ? "duplicate_channel" : "duplicate_settlement";
    throw new HttpError(409, why, "a review for this already exists", { existingId: dup.id });
  }
  if (await env.DB.prepare("SELECT 1 AS x FROM receipts WHERE nonce = ?").bind(p.nonce).first()) {
    throw new HttpError(409, "duplicate_nonce", "nonce already used by a receipt");
  }

  // flopwatchReceiptId must agree with the review (§7.3).
  if (p.flopwatchReceiptId) {
    const r = await env.DB.prepare("SELECT did, network, channel_id, buyer, miner FROM receipts WHERE id = ?")
      .bind(p.flopwatchReceiptId)
      .first<{ did: string; network: string; channel_id: string | null; buyer: string; miner: string }>();
    if (!r) throw new HttpError(400, "receipt_not_found", "flopwatchReceiptId does not exist");
    if (r.did !== p.did) throw new HttpError(403, "receipt_did_mismatch", "that receipt was signed by a different DID");
    if (r.network !== p.network || r.channel_id !== channelId || r.buyer !== p.buyer || r.miner !== p.miner) {
      throw new HttpError(400, "receipt_mismatch", "flopwatchReceiptId is for a different session");
    }
  }

  // Reviewer is the buyer (§7.3): binding, wallet signature over this review, or a counted receipt by this DID as this buyer.
  let buyerProof: string | null = null;
  if (await env.DB.prepare("SELECT 1 AS x FROM bindings WHERE did = ? AND wallet = ? AND network = ?").bind(p.did, p.buyer, p.network).first()) {
    buyerProof = "binding";
  } else if (typeof walletSignature === "string" && verifyWalletSignature(canonical, walletSignature, p.buyer)) {
    buyerProof = "wallet_signature";
  } else if (
    await env.DB.prepare("SELECT 1 AS x FROM receipts WHERE network = ? AND channel_id = ? AND did = ? AND buyer = ? AND counted = 1")
      .bind(p.network, channelId, p.did, p.buyer)
      .first()
  ) {
    buyerProof = "receipt";
  }
  if (!buyerProof) {
    throw new HttpError(403, "buyer_not_proven", "prove you control the buyer wallet: POST /v1/bindings, add walletSignature, or submit a counted receipt for this channel first");
  }

  const selfDealing = await selfDealingReason(env, p);
  const r2Key = `reviews/${p.submittedAt.slice(0, 4)}/${p.submittedAt.slice(5, 7)}/${id}.json`;
  try {
    await env.DB.prepare(
      `INSERT INTO reviews (id, network, did, buyer, miner, model, model_hash, channel_id, settlement_tx, block_number, scores_json,
         delivered, prompt_category, latency_ms, paid_flop, max_flop, notes, flopwatch_receipt_id, submitted_at, nonce, payload_json,
         signature, wallet_signature, buyer_proof, r2_key, received_at, excluded_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, p.network, p.did, p.buyer, p.miner, p.model, p.modelHash ?? null, channelId, settlementTx, p.blockNumber ?? null,
      JSON.stringify(p.scores), p.delivered ? 1 : 0, p.promptCategory ?? null, p.latencyMs ?? null, p.paidFlop ?? null,
      p.maxFlop ?? null, v.notes ?? null, p.flopwatchReceiptId ?? null, p.submittedAt, p.nonce, canonical, envelope.signature,
      typeof walletSignature === "string" ? walletSignature.toLowerCase() : null, buyerProof, r2Key, now, selfDealing,
    ).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "duplicate_review", "a review for this already exists");
    throw e;
  }
  const put = env.BUCKET.put(r2Key, JSON.stringify({ payload: p, signature: envelope.signature, walletSignature: walletSignature ?? null }), {
    httpMetadata: { contentType: "application/json" },
  });
  if (ctx.waitUntil) ctx.waitUntil(put);
  else await put;

  const state = await decideReview(env, id, p, selfDealing, "inline", verifier, now);
  if (state.verification === "pending_verification") {
    if (verifier.canVerify(p.network)) await env.VERIFY_QUEUE.send({ reviewId: id }, { delaySeconds: 60 });
    return { httpStatus: 202, body: { ...state, status: "pending_verification", buyerProof } };
  }
  return { httpStatus: 201, body: { ...state, status: state.counted ? "counted" : "stored_not_counted", buyerProof } };
}
