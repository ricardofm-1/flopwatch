import type { Env } from "../env";
import { intVar } from "../env";
import { HttpError, isPlainObject } from "../lib/http";
import { base64urlDecode, randomHex } from "../lib/encoding";
import { jcs, jcsBytes } from "../receipts/jcs";
import { didKeyToPublicKey, DidError, verifyEd25519 } from "../did/didkey";

export interface SiwdChallenge {
  specVersion: 1;
  kind: "flop.siwd.challenge";
  domain: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  statement: string;
}

export const SIWD_STATEMENT =
  "Sign in to Flopwatch to submit miner receipts and reviews. This signature does not move funds.";

export async function issueChallenge(
  env: Env,
  site: { domain: string; uri: string },
  ip: string,
  now = Date.now(),
): Promise<SiwdChallenge> {
  const ttl = Math.min(intVar(env.CHALLENGE_TTL_SECONDS, 300), 600);
  const challenge: SiwdChallenge = {
    specVersion: 1,
    kind: "flop.siwd.challenge",
    domain: site.domain,
    uri: site.uri,
    nonce: randomHex(16),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    statement: SIWD_STATEMENT,
  };
  await env.DB.prepare(
    "INSERT INTO challenges (nonce, challenge_json, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(challenge.nonce, jcs(challenge), ip, now, now + ttl * 1000)
    .run();
  return challenge;
}

/**
 * Verify a signed challenge and burn its nonce. Returns the authenticated DID.
 * Order: shape → origin binding → stored challenge matches → DID → signature → atomic burn.
 */
export async function verifyChallenge(
  env: Env,
  site: { domain: string; uri: string },
  body: unknown,
  now = Date.now(),
): Promise<string> {
  if (!isPlainObject(body)) throw new HttpError(400, "invalid_request");
  const { did, challenge, signature } = body;
  if (typeof did !== "string" || typeof signature !== "string" || !isPlainObject(challenge)) {
    throw new HttpError(400, "invalid_request", "expected { did, challenge, signature }");
  }
  if (challenge.kind !== "flop.siwd.challenge" || challenge.specVersion !== 1) {
    throw new HttpError(400, "invalid_challenge");
  }
  if (challenge.domain !== site.domain || challenge.uri !== site.uri) {
    throw new HttpError(401, "domain_mismatch", "challenge is bound to a different origin");
  }
  if (typeof challenge.nonce !== "string" || !/^[0-9a-f]{32}$/.test(challenge.nonce)) {
    throw new HttpError(400, "invalid_challenge");
  }
  const row = await env.DB.prepare("SELECT challenge_json, expires_at, used_at FROM challenges WHERE nonce = ?")
    .bind(challenge.nonce)
    .first<{ challenge_json: string; expires_at: number; used_at: number | null }>();
  if (!row) throw new HttpError(401, "unknown_nonce");
  if (row.used_at !== null) throw new HttpError(401, "nonce_used");
  if (row.expires_at <= now) throw new HttpError(401, "challenge_expired");
  let canonical: string;
  try {
    canonical = jcs(challenge);
  } catch {
    throw new HttpError(400, "invalid_challenge");
  }
  if (canonical !== row.challenge_json) throw new HttpError(401, "challenge_mismatch", "challenge was altered");

  let pub: Uint8Array;
  try {
    pub = didKeyToPublicKey(did);
  } catch (e) {
    throw new HttpError(400, "invalid_did", e instanceof DidError ? e.message : "invalid did");
  }
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(signature);
  } catch {
    throw new HttpError(400, "invalid_signature_encoding");
  }
  if (!(await verifyEd25519(pub, jcsBytes(challenge), sig))) {
    throw new HttpError(401, "invalid_signature");
  }
  // Atomic single-use burn: concurrent verifies cannot both succeed.
  const res = await env.DB.prepare(
    "UPDATE challenges SET used_at = ?1 WHERE nonce = ?2 AND used_at IS NULL AND expires_at > ?1",
  )
    .bind(now, challenge.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw new HttpError(401, "nonce_used");
  return did;
}

export async function pruneChallenges(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now - 86400_000).run();
  await env.DB.prepare("DELETE FROM sessions_revoked WHERE expires_at < ?").bind(now).run();
}

export { jcsBytes };
