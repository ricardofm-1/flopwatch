import { isDidKey } from "../did/didkey";
import { isSs58 } from "../did/ss58";
import { isPlainObject } from "../lib/http";
import type { Network } from "../env";

/** FLOPWATCH-BUYER-REVIEWS-SPEC §6. */
export const SCORE_KEYS = ["quality", "latency", "cost", "delivery"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number | null>;
export const PROMPT_CATEGORIES = ["coding", "reasoning", "writing", "extraction", "translation", "chat", "other"] as const;

export interface ReviewPayload {
  specVersion: 1;
  kind: "flop.miner-review";
  network: Network;
  did: string;
  submittedAt: string;
  nonce: string;
  buyer: string;
  miner: string;
  model: string;
  modelHash?: string | null;
  channelId: string;
  settlementTx?: string | null;
  blockNumber?: number | null;
  scores: Scores;
  delivered: boolean;
  promptCategory?: (typeof PROMPT_CATEGORIES)[number] | null;
  latencyMs?: number | null;
  paidFlop?: string | null;
  maxFlop?: string | null;
  notes?: string | null;
  flopwatchReceiptId?: string | null;
}

const ALLOWED = new Set([
  "specVersion", "kind", "network", "did", "submittedAt", "nonce", "buyer", "miner", "model", "modelHash", "channelId",
  "settlementTx", "blockNumber", "scores", "delivered", "promptCategory", "latencyMs", "paidFlop", "maxFlop", "notes",
  "flopwatchReceiptId",
]);
/** Same strip list as receipts, plus the SDK's sessionSeed (§0.5, §5.1). */
const FORBIDDEN_HINT: Record<string, string> = {
  reply: "never submit the model's reply",
  prompt: "never submit the prompt",
  output: "never submit model output",
  endpoint: "never submit the raw miner URL",
  url: "never submit the raw miner URL",
  mnemonic: "never submit wallet secrets",
  sessionSeed: "never submit the SDK sessionSeed",
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DECIMAL = /^(0|[1-9]\d{0,29})(\.\d{1,30})?$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const NOTES_MAX = 500;

export interface ReviewValidation {
  ok: boolean;
  errors: string[];
  payload?: ReviewPayload;
  /** Trimmed notes (empty → null) for storage. The signed payload itself is never rewritten. */
  notes?: string | null;
}

const isIso = (v: unknown): v is string => typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const nonNegInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function validateReviewPayload(p: unknown): ReviewValidation {
  const errors: string[] = [];
  if (!isPlainObject(p)) return { ok: false, errors: ["payload must be an object"] };
  for (const k of Object.keys(p)) {
    if (!ALLOWED.has(k)) errors.push(FORBIDDEN_HINT[k] ? `field '${k}' not allowed: ${FORBIDDEN_HINT[k]}` : `unknown field '${k}'`);
  }
  const opt = (k: string) => p[k] === undefined || p[k] === null;

  if (p.specVersion !== 1) errors.push("specVersion must be 1");
  if (p.kind !== "flop.miner-review") errors.push("kind must be 'flop.miner-review'");
  if (p.network !== "testnet" && p.network !== "devnet") errors.push("network must be 'testnet' or 'devnet'");
  if (!isDidKey(p.did)) errors.push("did must be an Ed25519 did:key");
  if (!isIso(p.submittedAt)) errors.push("submittedAt must be ISO-8601 UTC");
  if (typeof p.nonce !== "string" || !/^[0-9a-f]{32}$/.test(p.nonce)) errors.push("nonce must be 128-bit lowercase hex");
  if (!isSs58(p.buyer)) errors.push("buyer must be a valid SS58 address");
  if (!isSs58(p.miner)) errors.push("miner must be a valid SS58 address");
  if (typeof p.model !== "string" || p.model.length < 1 || p.model.length > 200) errors.push("model must be 1–200 chars");
  if (!opt("modelHash") && (typeof p.modelHash !== "string" || !HEX32.test(p.modelHash))) errors.push("modelHash must be 0x + 64 hex");
  if (typeof p.channelId !== "string" || !HEX32.test(p.channelId)) errors.push("channelId must be the on-chain channel id (0x + 64 hex)");
  if (!opt("settlementTx") && (typeof p.settlementTx !== "string" || !HEX32.test(p.settlementTx))) errors.push("settlementTx must be 0x + 64 hex");
  if (!opt("blockNumber") && !nonNegInt(p.blockNumber)) errors.push("blockNumber must be a non-negative integer");

  if (!isPlainObject(p.scores)) errors.push("scores must be an object with quality, latency, cost, delivery");
  else {
    const scores = p.scores;
    for (const k of Object.keys(scores)) if (!(SCORE_KEYS as readonly string[]).includes(k)) errors.push(`unknown score '${k}'`);
    let rated = 0;
    for (const k of SCORE_KEYS) {
      const v = scores[k];
      if (v === null) continue;
      if (v === undefined) errors.push(`scores.${k} is required (1–5 or null)`);
      else if (!(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5)) errors.push(`scores.${k} must be an integer 1–5 or null`);
      else rated++;
    }
    if (rated === 0) errors.push("at least one score must be rated");
  }
  if (typeof p.delivered !== "boolean") errors.push("delivered must be boolean");
  if (!opt("promptCategory") && !(PROMPT_CATEGORIES as readonly unknown[]).includes(p.promptCategory)) {
    errors.push(`promptCategory must be one of ${PROMPT_CATEGORIES.join(", ")}`);
  }
  if (!opt("latencyMs") && !(typeof p.latencyMs === "number" && Number.isFinite(p.latencyMs) && p.latencyMs >= 0 && p.latencyMs < 86_400_000)) {
    errors.push("latencyMs must be a non-negative number");
  }
  for (const k of ["paidFlop", "maxFlop"]) {
    if (!opt(k) && (typeof p[k] !== "string" || !DECIMAL.test(p[k] as string))) errors.push(`${k} must be a decimal FLOP string (e.g. "0.0425")`);
  }
  let notes: string | null = null;
  if (!opt("notes")) {
    if (typeof p.notes !== "string") errors.push("notes must be a string");
    else {
      const t = p.notes.trim();
      if (t.length > NOTES_MAX) errors.push(`notes must be at most ${NOTES_MAX} characters`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t)) errors.push("notes may not contain control characters (newlines are fine)");
      notes = t === "" ? null : t;
    }
  }
  if (!opt("flopwatchReceiptId") && (typeof p.flopwatchReceiptId !== "string" || !/^[0-9a-f]{64}$/.test(p.flopwatchReceiptId))) {
    errors.push("flopwatchReceiptId must be a 64-hex receipt id");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, payload: p as unknown as ReviewPayload, notes };
}

const FIVE_MIN = 5 * 60_000;

/** Pre-chain freshness: not from the future. The 30-day-after-session rule needs the chain (see process.ts). */
export function checkSubmittedAt(p: ReviewPayload, now = Date.now()): string | null {
  if (Date.parse(p.submittedAt) > now + FIVE_MIN) return "submittedAt is in the future";
  return null;
}
