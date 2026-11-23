import type { Env } from "../env";
import { intVar } from "../env";
import { HttpError, isPlainObject } from "../lib/http";
import { base64urlDecode, sha256Hex } from "../lib/encoding";
import { verifyDidSignature } from "../did/didkey";
import { enforceRateLimits } from "../lib/ratelimit";
import { getVerifier, VerifierConfigError } from "../verify";
import { jcs, jcsBytes } from "./jcs";
import { checkFreshness, validateReceiptPayload } from "./schema";
import { runVerification, selfDealingReason, type ReceiptState } from "./process";

export interface SubmitResult {
  httpStatus: 201 | 202;
  body: ReceiptState & { status: string };
}

export async function submitReceipt(
  env: Env,
  ctx: { sessionDid: string; ip: string; waitUntil?: (p: Promise<unknown>) => void },
  envelope: unknown,
  now = Date.now(),
): Promise<SubmitResult> {
  const hourly = intVar(env.RATE_LIMIT_SUBMIT_HOURLY, 30);
  const daily = intVar(env.RATE_LIMIT_SUBMIT_DAILY, 200);
  await enforceRateLimits(
    env,
    [
      { key: `submit:did:${ctx.sessionDid}:h`, windowSeconds: 3600, max: hourly },
      { key: `submit:did:${ctx.sessionDid}:d`, windowSeconds: 86400, max: daily },
      { key: `submit:ip:${ctx.ip}:h`, windowSeconds: 3600, max: hourly },
      { key: `submit:ip:${ctx.ip}:d`, windowSeconds: 86400, max: daily },
    ],
    now,
  );

  // Fail closed before touching storage if the verifier is misconfigured (e.g. mock in prod).
  try {
    getVerifier(env);
  } catch (e) {
    if (e instanceof VerifierConfigError) throw new HttpError(503, "verifier_misconfigured", e.message);
    throw e;
  }

  if (!isPlainObject(envelope) || !isPlainObject(envelope.payload) || typeof envelope.signature !== "string") {
    throw new HttpError(400, "invalid_envelope", "expected { payload, signature }");
  }
  const extra = Object.keys(envelope).filter((k) => k !== "payload" && k !== "signature");
  if (extra.length) throw new HttpError(400, "invalid_envelope", `unexpected envelope fields: ${extra.join(", ")}`);

  const v = validateReceiptPayload(envelope.payload);
  if (!v.ok || !v.payload) throw new HttpError(400, "invalid_receipt", "receipt failed validation", { errors: v.errors });
  const payload = v.payload;

  if (payload.did !== ctx.sessionDid) throw new HttpError(403, "did_mismatch", "payload.did must equal the session DID");

  let sig: Uint8Array;
  try {
    sig = base64urlDecode(envelope.signature);
  } catch {
    throw new HttpError(400, "invalid_signature_encoding");
  }
  const signed = jcsBytes(payload);
  if (!(await verifyDidSignature(payload.did, signed, sig))) {
    throw new HttpError(400, "invalid_receipt_signature", "signature does not verify over JCS(payload)");
  }

  const stale = checkFreshness(payload, now);
  if (stale) throw new HttpError(400, "stale_receipt", stale);

  const id = await sha256Hex(signed);
  const network = payload.network;
  const rawChannel = payload.channelId == null ? null : String(payload.channelId);
  // On-chain channel ids (0x + 32-byte hash) are normalised to lowercase so dedupe can't be dodged by case.
  const channelId = rawChannel && /^0x[0-9a-fA-F]{64}$/.test(rawChannel) ? rawChannel.toLowerCase() : rawChannel;
  const onChainChannel = channelId !== null && /^0x[0-9a-f]{64}$/.test(channelId) ? channelId : null;
  const settlementTx = payload.settlementTx ? payload.settlementTx.toLowerCase() : null;

  const dup = await env.DB.prepare(
    `SELECT id, nonce, settlement_tx, channel_id FROM receipts
      WHERE id = ?1 OR nonce = ?2
         OR (?4 IS NOT NULL AND network = ?3 AND settlement_tx = ?4)
         OR (?5 IS NOT NULL AND network = ?3 AND channel_id = ?5) LIMIT 1`,
  )
    .bind(id, payload.nonce, network, settlementTx, onChainChannel)
    .first<{ id: string; nonce: string; settlement_tx: string | null; channel_id: string | null }>();
  if (dup) {
    const why =
      dup.id === id ? "duplicate_receipt"
      : dup.nonce === payload.nonce ? "duplicate_nonce"
      : settlementTx !== null && dup.settlement_tx === settlementTx ? "duplicate_settlement"
      : "duplicate_channel";
    throw new HttpError(409, why, "receipt already submitted", { existingId: dup.id });
  }

  const excludedReason = await selfDealingReason(env, payload);
  const r2Key = `receipts/${payload.submittedAt.slice(0, 4)}/${payload.submittedAt.slice(5, 7)}/${id}.json`;

  try {
    await env.DB.prepare(
      `INSERT INTO receipts (id, network, did, buyer, miner, model, model_hash, channel_id, settlement_tx, block_number,
         status, ok, max_flop, paid_flop, prompt_tokens, completion_tokens, latency_ms, error_class, started_at,
         finished_at, submitted_at, nonce, payload_json, signature, r2_key, received_at, excluded_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id, network, payload.did, payload.buyer, payload.miner, payload.model, payload.modelHash ?? null, channelId,
        settlementTx, payload.blockNumber ?? null, payload.status, payload.ok ? 1 : 0, payload.maxFlop,
        payload.paidFlop ?? null, payload.promptTokens ?? null, payload.completionTokens ?? null,
        payload.latencyMs ?? null, payload.errorClass ?? null, payload.startedAt, payload.finishedAt ?? null,
        payload.submittedAt, payload.nonce, jcs(payload), envelope.signature, r2Key, now, excludedReason,
      )
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "duplicate_receipt", "receipt already submitted");
    throw e;
  }

  // Immutable auditor copy (private bucket prefix; not served publicly because it contains the DID and buyer).
  const put = env.BUCKET.put(r2Key, JSON.stringify({ payload, signature: envelope.signature }), {
    httpMetadata: { contentType: "application/json" },
  });
  if (ctx.waitUntil) ctx.waitUntil(put);
  else await put;

  const state = await runVerification(env, id, payload, excludedReason, "inline");
  if (state.verification === "pending_verification") {
    if (getVerifier(env).canVerify(network)) await env.VERIFY_QUEUE.send({ receiptId: id }, { delaySeconds: 30 });
    return { httpStatus: 202, body: { ...state, status: "pending_verification" } };
  }
  return { httpStatus: 201, body: { ...state, status: state.counted ? "counted" : "stored_not_counted" } };
}
