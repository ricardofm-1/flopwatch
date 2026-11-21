import type { Context } from "hono";
import type { Env } from "../env";

export type AppEnv = { Bindings: Env; Variables: { did?: string; jti?: string } };
export type AppCtx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

const MAX_BODY = 32 * 1024;

/** Read a JSON body with a hard size cap. */
export async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new HttpError(413, "body_too_large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "body_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function siteOrigin(env: Env, req: Request): { domain: string; uri: string } {
  const origin = (env.SITE_ORIGIN ?? "").trim() || new URL(req.url).origin;
  const u = new URL(origin);
  return { domain: u.host, uri: u.origin };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
