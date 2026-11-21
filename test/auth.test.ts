import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, getChallenge, newKey, sign, uniqueIp } from "./helpers";

describe("SIWD challenge → verify → JWT (acceptance 2)", () => {
  it("happy path issues a JWT and HttpOnly cookie; session endpoint sees it", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const challenge = await getChallenge(ip);
    expect(challenge).toMatchObject({ kind: "flop.siwd.challenge", domain: "board.test", uri: "https://board.test" });
    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    const ttl = Date.parse(challenge.expiresAt as string) - Date.parse(challenge.issuedAt as string);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);

    const r = await call("/v1/auth/verify", {
      method: "POST",
      ip,
      body: JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) }),
    });
    expect(r.status).toBe(200);
    expect(r.json.did).toBe(key.did);
    expect(r.json.token.split(".")).toHaveLength(3);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/flop_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const s = await call("/v1/auth/session", { token: r.json.token, ip });
    expect(s.json.did).toBe(key.did);
  });

  it("rejects a reused nonce", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const challenge = await getChallenge(ip);
    const body = JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) });
    expect((await call("/v1/auth/verify", { method: "POST", ip, body })).status).toBe(200);
    const again = await call("/v1/auth/verify", { method: "POST", ip, body });
    expect(again.status).toBe(401);
    expect(again.json.error).toBe("nonce_used");
  });

  it("rejects an expired challenge", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const challenge = await getChallenge(ip);
    await env.DB.prepare("UPDATE challenges SET expires_at = ? WHERE nonce = ?").bind(Date.now() - 1000, challenge.nonce).run();
    const r = await call("/v1/auth/verify", {
      method: "POST",
      ip,
      body: JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) }),
    });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("challenge_expired");
  });

  it("rejects a challenge signed for another domain", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const challenge = { ...(await getChallenge(ip)), domain: "evil.example", uri: "https://evil.example" };
    const r = await call("/v1/auth/verify", {
      method: "POST",
      ip,
      body: JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) }),
    });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("domain_mismatch");
  });

  it("rejects a tampered challenge, wrong signer and an unknown nonce", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const c1 = { ...(await getChallenge(ip)), statement: "something else" };
    const r1 = await call("/v1/auth/verify", { method: "POST", ip, body: JSON.stringify({ did: key.did, challenge: c1, signature: sign(key, c1) }) });
    expect(r1.json.error).toBe("challenge_mismatch");

    const c2 = await getChallenge(ip);
    const r2 = await call("/v1/auth/verify", { method: "POST", ip, body: JSON.stringify({ did: key.did, challenge: c2, signature: sign(newKey(), c2) }) });
    expect(r2.status).toBe(401);
    expect(r2.json.error).toBe("invalid_signature");
    // Failed signature does not burn the nonce: the real holder can still use it.
    const r2b = await call("/v1/auth/verify", { method: "POST", ip, body: JSON.stringify({ did: key.did, challenge: c2, signature: sign(key, c2) }) });
    expect(r2b.status).toBe(200);

    const c3 = { ...(await getChallenge(ip)), nonce: "0".repeat(32) };
    const r3 = await call("/v1/auth/verify", { method: "POST", ip, body: JSON.stringify({ did: key.did, challenge: c3, signature: sign(key, c3) }) });
    expect(r3.json.error).toBe("unknown_nonce");
  });

  it("rejects forged and revoked tokens", async () => {
    const r = await call("/v1/receipts", { method: "POST", token: "x.y.z", body: "{}" });
    expect(r.status).toBe(401);
    const ip = uniqueIp();
    const key = newKey();
    const challenge = await getChallenge(ip);
    const v = await call("/v1/auth/verify", { method: "POST", ip, body: JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) }) });
    await call("/v1/auth/logout", { method: "POST", token: v.json.token, ip, body: "{}" });
    const after = await call("/v1/auth/session", { token: v.json.token, ip });
    expect(after.json.did).toBeNull();
  });
});
