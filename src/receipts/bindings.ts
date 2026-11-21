import * as sr25519 from "@scure/sr25519";
import type { Env } from "../env";
import { HttpError, isPlainObject } from "../lib/http";
import { base64urlDecode, hexToBytes, utf8 } from "../lib/encoding";
import { ss58Decode } from "../did/ss58";
import { verifyDidSignature } from "../did/didkey";
import { jcs, jcsBytes } from "./jcs";

/**
 * Optional DID ↔ wallet binding (SPEC §4). Both keys attest to the same JCS payload:
 *   { specVersion: 1, kind: "flop.wallet-binding", network, did, wallet, issuedAt, nonce }
 * walletSignature: sr25519 (hex) over the JCS bytes — raw, or wrapped as <Bytes>…</Bytes> (polkadot signRaw).
 * didSignature: Ed25519 (base64url) over the same bytes.
 */
export async function submitBinding(env: Env, sessionDid: string, body: unknown, now = Date.now()) {
  if (!isPlainObject(body) || !isPlainObject(body.payload)) throw new HttpError(400, "invalid_binding");
  const { payload, walletSignature, didSignature } = body as {
    payload: Record<string, unknown>;
    walletSignature: unknown;
    didSignature: unknown;
  };
  if (payload.kind !== "flop.wallet-binding" || payload.specVersion !== 1) throw new HttpError(400, "invalid_binding", "bad kind/specVersion");
  if (payload.network !== "testnet" && payload.network !== "devnet") throw new HttpError(400, "invalid_binding", "bad network");
  if (payload.did !== sessionDid) throw new HttpError(403, "did_mismatch");
  if (typeof payload.wallet !== "string" || typeof payload.issuedAt !== "string" || typeof payload.nonce !== "string") {
    throw new HttpError(400, "invalid_binding", "wallet, issuedAt, nonce required");
  }
  const issued = Date.parse(payload.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > 10 * 60_000) throw new HttpError(400, "stale_binding");
  if (typeof walletSignature !== "string" || typeof didSignature !== "string") throw new HttpError(400, "invalid_binding", "signatures required");

  let walletPub: Uint8Array;
  try {
    walletPub = ss58Decode(payload.wallet).publicKey;
  } catch {
    throw new HttpError(400, "invalid_wallet");
  }
  const msg = jcsBytes(payload);
  const wrapped = utf8.encode(`<Bytes>${jcs(payload)}</Bytes>`);
  let wsig: Uint8Array;
  try {
    wsig = hexToBytes(walletSignature);
  } catch {
    throw new HttpError(400, "invalid_signature_encoding");
  }
  const walletOk = wsig.length === 64 && (sr25519.verify(msg, wsig, walletPub) || sr25519.verify(wrapped, wsig, walletPub));
  if (!walletOk) throw new HttpError(400, "invalid_wallet_signature");
  let dsig: Uint8Array;
  try {
    dsig = base64urlDecode(didSignature);
  } catch {
    throw new HttpError(400, "invalid_signature_encoding");
  }
  if (!(await verifyDidSignature(sessionDid, msg, dsig))) throw new HttpError(400, "invalid_did_signature");

  await env.DB.prepare(
    `INSERT INTO bindings (did, wallet, network, payload_json, wallet_signature, did_signature, created_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT (did, wallet, network) DO NOTHING`,
  )
    .bind(sessionDid, payload.wallet, payload.network, jcs(payload), walletSignature.toLowerCase(), didSignature, now)
    .run();
  return { did: sessionDid, wallet: payload.wallet, network: payload.network, bound: true };
}
