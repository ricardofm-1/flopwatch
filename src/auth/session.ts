import { SignJWT, jwtVerify } from "jose";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { intVar } from "../env";
import { HttpError, type AppCtx } from "../lib/http";
import { randomHex } from "../lib/encoding";

export const SESSION_COOKIE = "flop_session";

function signingKey(env: Env): Uint8Array {
  const k = env.SESSION_SIGNING_KEY;
  if (!k || k.length < 32) throw new HttpError(503, "server_not_configured", "SESSION_SIGNING_KEY missing or too short");
  return new TextEncoder().encode(k);
}

export async function issueSession(env: Env, did: string, audience: string, now = Date.now()) {
  const ttl = Math.min(Math.max(intVar(env.SESSION_TTL_SECONDS, 1800), 900), 3600);
  const iat = Math.floor(now / 1000);
  const exp = iat + ttl;
  const jti = randomHex(16);
  const token = await new SignJWT({ did })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .setIssuer(audience)
    .setAudience(audience)
    .setSubject(did)
    .sign(signingKey(env));
  return { token, expiresAt: new Date(exp * 1000).toISOString(), ttl, jti };
}

export async function readSession(
  env: Env,
  c: AppCtx,
  audience: string,
): Promise<{ did: string; jti: string; exp: number } | null> {
  const auth = c.req.header("authorization");
  let token: string | undefined;
  if (auth?.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
  else token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(env), {
      algorithms: ["HS256"],
      issuer: audience,
      audience,
    });
    if (typeof payload.did !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    const revoked = await env.DB.prepare("SELECT 1 AS r FROM sessions_revoked WHERE jti = ?").bind(payload.jti).first();
    if (revoked) return null;
    return { did: payload.did, jti: payload.jti, exp: payload.exp };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

export async function revokeSession(env: Env, did: string, jti: string, exp: number): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO sessions_revoked (jti, did, revoked_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(jti, did, Date.now(), exp * 1000)
    .run();
}
