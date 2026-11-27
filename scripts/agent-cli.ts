/**
 * Headless agent client for Flopwatch (https://github.com/ricardofm-1/flopwatch).
 * The DID private key is read from FLOP_DID_PRIVATE_KEY (env only) and never sent anywhere.
 *
 *   FLOP_BOARD_URL=https://… FLOP_DID_PRIVATE_KEY=<hex seed> npx tsx scripts/agent-cli.ts <command>
 *
 * Commands:
 *   keygen                    generate a new Ed25519 did:key (prints the secret ONCE; store it yourself)
 *   did                       print the DID for FLOP_DID_PRIVATE_KEY
 *   sign-challenge [file|-]   sign a challenge (JSON or {challenge}) and print only the signature
 *   login                     challenge → sign → verify; prints the session token
 *   sign-receipt <file>       complete + sign a receipt payload; prints the envelope
 *   submit <file>             sign-receipt, login, POST /v1/receipts. On failure the envelope goes to ./.flop-outbox/
 *   flush                     retry everything in ./.flop-outbox/ (receipts and reviews)
 *
 * Buyer reviews (after a wallet-funded runDirectSession; scores are yours to give, never automatic):
 *   review-from-session <session.json> <input.json>
 *                             map an SDK DirectSessionResult + your scores to a review draft (stdout).
 *                             Never copies reply / receipts[].output / sessionSeed.
 *   sign-review <file>        complete + sign a review payload; prints the envelope
 *   review-signing-input <envelope.json>
 *                             print the exact JCS bytes your buyer wallet must sign (sr25519) if you
 *                             have no /v1/bindings binding and no counted receipt for that channel
 *   submit-review <file> [--wallet-sig <hex>]
 *                             sign (unless already an envelope), login, POST /v1/reviews.
 *                             409 duplicate_channel / duplicate_review = already reviewed (exit 0). Failures go to ./.flop-outbox/
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDidKey } from "../src/did/didkey";
import { jcs, jcsBytes } from "../src/receipts/jcs";
import { reviewFromSession, type DirectSessionResultLike, type ReviewInput } from "../src/reviews/map";
import { base64urlDecode, base64urlEncode, bytesToHex, hexToBytes, randomHex } from "../src/lib/encoding";

const OUTBOX = ".flop-outbox";
const boardUrl = () => (process.env.FLOP_BOARD_URL ?? "http://localhost:8787").replace(/\/$/, "");

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Accepts a 32-byte seed (or 64-byte seed‖pub) as hex, base64url, or multibase z… (ed25519-priv 0x1300). */
function loadSecret(): Uint8Array {
  const raw = (process.env.FLOP_DID_PRIVATE_KEY ?? "").trim();
  if (!raw) die("FLOP_DID_PRIVATE_KEY is not set");
  let b: Uint8Array;
  try {
    if (/^(0x)?[0-9a-fA-F]+$/.test(raw)) b = hexToBytes(raw);
    else if (raw.startsWith("z")) {
      b = bs58.decode(raw.slice(1));
      if (b[0] === 0x80 && b[1] === 0x26) b = b.slice(2);
    } else b = base64urlDecode(raw);
  } catch {
    die("FLOP_DID_PRIVATE_KEY is not valid hex, base64url or multibase");
  }
  if (b.length === 64) b = b.slice(0, 32);
  if (b.length !== 32) die("FLOP_DID_PRIVATE_KEY must decode to a 32-byte Ed25519 seed");
  return b;
}

const didOf = (sk: Uint8Array) => publicKeyToDidKey(ed25519.getPublicKey(sk));
const signJcs = (sk: Uint8Array, v: unknown) => base64urlEncode(ed25519.sign(jcsBytes(v), sk));

function readInput(file?: string): unknown {
  const text = !file || file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    die("input is not valid JSON");
  }
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${boardUrl()}${path}`, {
    method: "POST",
    // Explicit UA: Cloudflare's bot check on workers.dev rejects some default library UAs (e.g. Python-urllib) with 1010.
    headers: {
      "content-type": "application/json",
      "user-agent": "flopwatch-agent-cli/0.1 (+https://github.com/ricardofm-1/flopwatch)",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function login(sk: Uint8Array): Promise<string> {
  const c = await post("/v1/auth/challenge", { did: didOf(sk) });
  if (c.status !== 200) die(`challenge failed: ${c.status} ${JSON.stringify(c.json)}`);
  const challenge = c.json.challenge;
  const v = await post("/v1/auth/verify", { did: didOf(sk), challenge, signature: signJcs(sk, challenge) });
  if (v.status !== 200) die(`verify failed: ${v.status} ${JSON.stringify(v.json)}`);
  return v.json.token as string;
}

/** Fill protocol fields, drop anything that must never be submitted, sign. */
function buildEnvelope(sk: Uint8Array, input: unknown) {
  if (typeof input !== "object" || input === null) die("receipt must be a JSON object");
  const src = { ...(("payload" in input ? (input as { payload: object }).payload : input) as Record<string, unknown>) };
  for (const k of ["reply", "prompt", "output", "endpoint", "url", "mnemonic"]) delete src[k];
  const payload = {
    specVersion: 1,
    kind: "flop.miner-receipt",
    ...src,
    did: didOf(sk),
    nonce: typeof src.nonce === "string" ? src.nonce : randomHex(16),
    submittedAt: new Date().toISOString(),
  };
  return { payload, signature: signJcs(sk, payload) };
}

/** Strip anything that must never leave the machine, fill protocol fields, sign. */
function buildReviewEnvelope(sk: Uint8Array, input: unknown) {
  if (typeof input !== "object" || input === null) die("review must be a JSON object");
  const src = { ...(("payload" in input ? (input as { payload: object }).payload : input) as Record<string, unknown>) };
  for (const k of ["reply", "prompt", "output", "endpoint", "url", "mnemonic", "sessionSeed", "receipts"]) delete src[k];
  const payload = {
    specVersion: 1,
    kind: "flop.miner-review",
    ...src,
    did: didOf(sk),
    nonce: typeof src.nonce === "string" ? src.nonce : randomHex(16),
    submittedAt: new Date().toISOString(),
  };
  return { payload, signature: signJcs(sk, payload) };
}

type Envelope = { payload: Record<string, unknown>; signature: string; walletSignature?: string };
const isEnvelope = (x: unknown): x is Envelope =>
  typeof x === "object" && x !== null && "payload" in x && typeof (x as Envelope).signature === "string";

async function submitEnvelope(sk: Uint8Array, envelope: Envelope, token?: string) {
  const t = token ?? (await login(sk));
  const path = envelope.payload.kind === "flop.miner-review" ? "/v1/reviews" : "/v1/receipts";
  const r = await post(path, envelope, t);
  return { ...r, token: t };
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function saveOutbox(envelope: { payload: Record<string, unknown> }) {
  mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
  const f = join(OUTBOX, `${envelope.payload.nonce as string}.json`);
  writeFileSync(f, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  return f;
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "keygen": {
    const sk = ed25519.utils.randomSecretKey();
    console.error("Store this secret yourself (e.g. an env file with mode 600). It will not be shown again.");
    console.log(`FLOP_DID_PRIVATE_KEY=${bytesToHex(sk)}`);
    console.log(`DID=${didOf(sk)}`);
    break;
  }
  case "did":
    console.log(didOf(loadSecret()));
    break;
  case "sign-challenge": {
    const input = readInput(arg) as Record<string, unknown>;
    const challenge = (input.challenge ?? input) as Record<string, unknown>;
    if (challenge.kind !== "flop.siwd.challenge") die("not a flop.siwd.challenge");
    console.log(signJcs(loadSecret(), challenge));
    break;
  }
  case "login":
    console.log(await login(loadSecret()));
    break;
  case "sign-receipt":
    console.log(JSON.stringify(buildEnvelope(loadSecret(), readInput(arg)), null, 2));
    break;
  case "submit": {
    const sk = loadSecret();
    const envelope = buildEnvelope(sk, readInput(arg));
    try {
      const r = await submitEnvelope(sk, envelope);
      console.log(r.status, JSON.stringify(r.json));
      if (r.status >= 500 || r.status === 429) die(`kept for retry: ${saveOutbox(envelope)}`);
      if (r.status >= 400) process.exit(1);
    } catch (e) {
      die(`${(e as Error).message}; kept for retry: ${saveOutbox(envelope)}`);
    }
    break;
  }
  case "flush": {
    if (!existsSync(OUTBOX)) break;
    const sk = loadSecret();
    let token: string | undefined;
    for (const f of readdirSync(OUTBOX).filter((x) => x.endsWith(".json"))) {
      const path = join(OUTBOX, f);
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      const r = await submitEnvelope(sk, envelope, token);
      token = r.token;
      console.log(f, r.status, JSON.stringify(r.json));
      if (r.status < 500 && r.status !== 429) unlinkSync(path); // done, or permanently rejected
    }
    break;
  }
  case "review-from-session": {
    const session = readInput(arg) as DirectSessionResultLike & Record<string, unknown>;
    const input = readInput(process.argv[4]) as ReviewInput;
    try {
      const { payload, warnings } = reviewFromSession(session, input);
      for (const w of warnings) console.error(`warning: ${w}`);
      console.log(JSON.stringify(payload, null, 2));
    } catch (e) {
      die((e as Error).message);
    }
    break;
  }
  case "sign-review":
    console.log(JSON.stringify(buildReviewEnvelope(loadSecret(), readInput(arg)), null, 2));
    break;
  case "review-signing-input": {
    const env = readInput(arg);
    if (!isEnvelope(env)) die("pass a signed review envelope (from sign-review)");
    process.stdout.write(jcs(env.payload));
    break;
  }
  case "submit-review": {
    const sk = loadSecret();
    const input = readInput(arg);
    const envelope: Envelope = isEnvelope(input) ? input : buildReviewEnvelope(sk, input);
    if (envelope.payload.did !== didOf(sk)) die("envelope was signed by a different DID than FLOP_DID_PRIVATE_KEY");
    const ws = flagValue("--wallet-sig");
    if (ws) envelope.walletSignature = ws.replace(/^0x/i, "");
    try {
      const r = await submitEnvelope(sk, envelope);
      console.log(r.status, JSON.stringify(r.json));
      if (r.status === 202) console.error(`pending_verification: review ${String(r.json.id)} will be re-checked automatically`);
      // Already reviewed (this exact envelope, or another review of the same session): success.
      if (r.status === 409 && (r.json.error === "duplicate_channel" || r.json.error === "duplicate_review")) break;
      if (r.status >= 500 || r.status === 429) die(`kept for retry: ${saveOutbox(envelope)}`);
      if (r.status >= 400) process.exit(1);
    } catch (e) {
      die(`${(e as Error).message}; kept for retry: ${saveOutbox(envelope)}`);
    }
    break;
  }
  default:
    console.error(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    process.exit(cmd ? 1 : 0);
}
