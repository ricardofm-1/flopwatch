import { SELF } from "cloudflare:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDidKey } from "../src/did/didkey";
import { jcsBytes } from "../src/receipts/jcs";
import { base64urlEncode, bytesToHex, randomHex } from "../src/lib/encoding";
import { ss58Encode } from "../src/did/ss58";

export const ORIGIN = "https://board.test";

export interface TestKey {
  sk: Uint8Array;
  did: string;
}

export function newKey(): TestKey {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, did: publicKeyToDidKey(ed25519.getPublicKey(sk)) };
}

export function sign(key: TestKey, value: unknown): string {
  return base64urlEncode(ed25519.sign(jcsBytes(value), key.sk));
}

export function randomSs58(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ss58Encode(b);
}

let ipCounter = 0;
export function uniqueIp(): string {
  ipCounter++;
  return `203.0.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function call(path: string, init: RequestInit & { ip?: string; token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "198.51.100.1");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, headers: res.headers };
}

export async function getChallenge(ip?: string) {
  const r = await call("/v1/auth/challenge", { method: "POST", body: "{}", ip });
  if (r.status !== 200) throw new Error(`challenge ${r.status} ${r.text}`);
  return r.json.challenge as Record<string, unknown>;
}

export async function login(key: TestKey, ip?: string): Promise<string> {
  const challenge = await getChallenge(ip);
  const r = await call("/v1/auth/verify", {
    method: "POST",
    ip,
    body: JSON.stringify({ did: key.did, challenge, signature: sign(key, challenge) }),
  });
  if (r.status !== 200) throw new Error(`verify ${r.status} ${r.text}`);
  return r.json.token as string;
}

export function makePayload(did: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    specVersion: 1,
    kind: "flop.miner-receipt",
    network: "testnet",
    did,
    submittedAt: new Date(now).toISOString(),
    nonce: randomHex(16),
    buyer: randomSs58(),
    miner: randomSs58(),
    model: "llama-3.1-8b-instruct",
    channelId: `ch-${randomHex(4)}`,
    status: "settled",
    ok: true,
    settlementTx: `0x${randomHex(32)}`,
    blockNumber: 1234,
    maxFlop: "0.01",
    paidFlop: "0.004",
    promptTokens: 40,
    completionTokens: 160,
    latencyMs: 850,
    startedAt: new Date(now - 5_000).toISOString(),
    finishedAt: new Date(now - 4_000).toISOString(),
    promptHash: `sha256:${bytesToHex(new Uint8Array(32).fill(7))}`,
    review: { rating: 4 },
    ...over,
  };
}

export function envelope(key: TestKey, payload: Record<string, unknown>) {
  return { payload, signature: sign(key, payload) };
}

export async function submit(token: string, env: unknown, ip?: string) {
  return call("/v1/receipts", { method: "POST", token, ip, body: JSON.stringify(env) });
}
