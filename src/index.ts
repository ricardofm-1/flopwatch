import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env, VerifyJob } from "./env";
import { intVar } from "./env";
import { HttpError, clientIp, readJson, siteOrigin, isPlainObject, type AppCtx, type AppEnv } from "./lib/http";
import { enforceRateLimits } from "./lib/ratelimit";
import { issueChallenge, verifyChallenge } from "./auth/challenge";
import { issueSession, readSession, revokeSession, SESSION_COOKIE } from "./auth/session";
import { isDidKey } from "./did/didkey";
import { jcs } from "./receipts/jcs";
import { submitReceipt } from "./receipts/submit";
import { submitBinding } from "./receipts/bindings";
import { buildMeta, buildMinerFeed, buildMinersFeed, getPublicReceipt } from "./stats/feeds";
import { connectPage, homePage, methodologyPage, minerPage, notFoundPage } from "./pages/views";
import { APP_JS, CONNECT_JS, STYLE_CSS } from "./pages/static";
import { handleCron, handleVerifyBatch } from "./jobs";
import { isSs58 } from "./did/ss58";

const app = new Hono<AppEnv>();

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

app.use("*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (err.status === 429 && typeof err.extra.retryAfter === "number") headers["retry-after"] = String(err.extra.retryAfter);
    return c.json({ error: err.code, message: err.message, ...err.extra }, err.status as 400, headers);
  }
  console.error("unhandled", err instanceof Error ? err.message : String(err));
  return c.json({ error: "internal_error" }, 500);
});

function sameOriginOrThrow(c: { req: { header: (n: string) => string | undefined } }, origin: string) {
  // Cookie-authenticated browser POSTs must come from our own origin (defense in depth beyond SameSite=Lax).
  const o = c.req.header("origin");
  if (o && o !== origin) throw new HttpError(403, "bad_origin");
}

// ---------- Auth ----------
async function challengeHandler(c: AppCtx) {
  const site = siteOrigin(c.env, c.req.raw);
  const ip = clientIp(c.req.raw);
  let did: string | undefined;
  if (c.req.method === "POST") {
    const body = (await c.req.raw.clone().text()) ? await readJson(c.req.raw) : {};
    if (isPlainObject(body) && typeof body.did === "string" && body.did) {
      if (!isDidKey(body.did)) throw new HttpError(400, "invalid_did");
      did = body.did;
    }
  } else {
    const q = c.req.query("did");
    if (q && isDidKey(q)) did = q;
  }
  const max = intVar(c.env.RATE_LIMIT_CHALLENGE_HOURLY, 60);
  await enforceRateLimits(c.env, [
    { key: `challenge:ip:${ip}:h`, windowSeconds: 3600, max },
    ...(did ? [{ key: `challenge:did:${did}:h`, windowSeconds: 3600, max }] : []),
  ]);
  const challenge = await issueChallenge(c.env, site, ip);
  c.header("cache-control", "no-store");
  return c.json({ challenge, signingInput: jcs(challenge) });
}
app.post("/v1/auth/challenge", challengeHandler);
app.get("/v1/auth/challenge", challengeHandler);

app.post("/v1/auth/verify", async (c) => {
  const site = siteOrigin(c.env, c.req.raw);
  const ip = clientIp(c.req.raw);
  await enforceRateLimits(c.env, [
    { key: `verify:ip:${ip}:h`, windowSeconds: 3600, max: intVar(c.env.RATE_LIMIT_CHALLENGE_HOURLY, 60) },
  ]);
  const body = await readJson(c.req.raw);
  const did = await verifyChallenge(c.env, site, body);
  const s = await issueSession(c.env, did, site.uri);
  setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: s.ttl });
  c.header("cache-control", "no-store");
  return c.json({ did, token: s.token, tokenType: "Bearer", expiresAt: s.expiresAt });
});

app.get("/v1/auth/session", async (c) => {
  const site = siteOrigin(c.env, c.req.raw);
  const s = await readSession(c.env, c, site.uri).catch(() => null);
  c.header("cache-control", "no-store");
  return c.json({ did: s?.did ?? null, expiresAt: s ? new Date(s.exp * 1000).toISOString() : null });
});

app.post("/v1/auth/logout", async (c) => {
  const site = siteOrigin(c.env, c.req.raw);
  const s = await readSession(c.env, c, site.uri);
  if (s) await revokeSession(c.env, s.did, s.jti, s.exp);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

const requireSession = async (c: AppCtx, next: () => Promise<void>) => {
  const site = siteOrigin(c.env, c.req.raw);
  sameOriginOrThrow(c, site.uri);
  const s = await readSession(c.env, c, site.uri);
  if (!s) throw new HttpError(401, "unauthorized", "sign in with your DID first (POST /v1/auth/challenge, /v1/auth/verify)");
  c.set("did", s.did);
  c.set("jti", s.jti);
  await next();
};

// ---------- Receipts & bindings ----------
app.post("/v1/receipts", requireSession, async (c) => {
  const body = await readJson(c.req.raw);
  const res = await submitReceipt(c.env, {
    sessionDid: c.get("did")!,
    ip: clientIp(c.req.raw),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  }, body);
  return c.json(res.body, res.httpStatus);
});

app.get("/v1/receipts/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(404, "not_found");
  const r = await getPublicReceipt(c.env, id);
  if (!r) throw new HttpError(404, "not_found");
  return c.json(r);
});

app.post("/v1/bindings", requireSession, async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceRateLimits(c.env, [{ key: `binding:ip:${ip}:h`, windowSeconds: 3600, max: 20 }]);
  return c.json(await submitBinding(c.env, c.get("did")!, await readJson(c.req.raw)), 201);
});

// ---------- Feeds (edge-cached; D1 reads only on cache miss) ----------
async function cachedJson(c: AppCtx, build: () => Promise<unknown | null>) {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(c.req.url).toString(), { method: "GET" });
  const hit = await cache?.match(key);
  if (hit) return hit;
  const data = await build();
  if (data === null) return c.json({ error: "not_found" }, 404);
  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30, s-maxage=60",
      "access-control-allow-origin": "*",
    },
  });
  if (cache) c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}
const netParam = (v: string | undefined) => (v === "testnet" || v === "devnet" ? v : undefined);

app.get("/feeds/meta.json", (c) => cachedJson(c, () => buildMeta(c.env)));
app.get("/feeds/miners.json", (c) => cachedJson(c, () => buildMinersFeed(c.env, { network: netParam(c.req.query("network")) })));
app.get("/v1/miners", (c) => cachedJson(c, () => buildMinersFeed(c.env, { network: netParam(c.req.query("network")) })));
app.get("/feeds/miners/:file", (c) => {
  const file = c.req.param("file");
  const id = file.endsWith(".json") ? file.slice(0, -5) : file;
  if (!isSs58(id)) return c.json({ error: "not_found" }, 404);
  return cachedJson(c, () => buildMinerFeed(c.env, id, { network: netParam(c.req.query("network")) }));
});

// Daily public snapshots written to R2 by the cron (redacted like the feeds).
app.get("/data/*", async (c) => {
  // /data/miners.json, /data/index.json → R2 data/…; /data/snapshots/YYYY-MM-DD/<file> → R2 snapshots/…
  const path = new URL(c.req.url).pathname.slice("/data/".length);
  let objKey: string | null = null;
  if (/^[a-z0-9_-]+\.json$/.test(path)) objKey = `data/${path}`;
  else if (/^snapshots\/\d{4}-\d{2}-\d{2}\/[a-z]+\.(json|ndjson)$/.test(path)) objKey = path;
  const obj = objKey ? await c.env.BUCKET.get(objKey) : null;
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
});

// ---------- Static ----------
const asset = (body: string, type: string) => () =>
  new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } });
app.get("/static/style.css", asset(STYLE_CSS, "text/css; charset=utf-8"));
app.get("/static/app.js", asset(APP_JS, "text/javascript; charset=utf-8"));
app.get("/static/connect.js", asset(CONNECT_JS, "text/javascript; charset=utf-8"));

// ---------- Pages ----------
const page = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" } });
app.get("/", async (c) => page(await homePage(c.env, new URL(c.req.url).searchParams)));
app.get("/miner/:id", async (c) => {
  const id = c.req.param("id");
  if (!isSs58(id)) return page(notFoundPage(), 404);
  const body = await minerPage(c.env, id, new URL(c.req.url).searchParams);
  return body ? page(body) : page(notFoundPage(), 404);
});
app.get("/methodology", () => page(methodologyPage()));
app.get("/connect", (c) => {
  c.header("cache-control", "no-store");
  return new Response(connectPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});
app.get("/healthz", (c) => c.json({ ok: true }));

app.notFound((c) => (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/feeds/") ? c.json({ error: "not_found" }, 404) : page(notFoundPage(), 404)));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<VerifyJob>, env: Env) {
    await handleVerifyBatch(batch, env);
  },
  async scheduled(_ctl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
} satisfies ExportedHandler<Env, VerifyJob>;

export { app };
