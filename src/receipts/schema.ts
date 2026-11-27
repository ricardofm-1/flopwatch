import { isDidKey } from "../did/didkey";
import { isSs58 } from "../did/ss58";
import { isPlainObject } from "../lib/http";
import type { Network } from "../env";

export const RECEIPT_STATUSES = ["settled", "failed", "timeout", "challenged", "pending", "rejected"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const ERROR_CLASSES = ["timeout", "rpc", "miner-unreachable", "settlement", "proof"] as const;

/** SPEC §6.1 payload v1. Optional fields may be absent or null. */
export interface ReceiptPayload {
  specVersion: 1;
  kind: "flop.miner-receipt";
  network: Network;
  did: string;
  submittedAt: string;
  nonce: string;
  buyer: string;
  miner: string;
  model: string;
  modelHash?: string | null;
  channelId?: string | number | null;
  status: ReceiptStatus;
  ok: boolean;
  settlementTx?: string | null;
  blockNumber?: number | null;
  maxFlop: string;
  paidFlop?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  startedAt: string;
  finishedAt?: string | null;
  errorClass?: (typeof ERROR_CLASSES)[number] | null;
  promptHash: string;
  outputHash?: string | null;
  endpointHash?: string | null;
  /** Mandatory buyer review, signed with the receipt. */
  review: ReceiptReview;
}

export interface ReceiptReview {
  /** Overall rating, 1–5 stars in 0.5 steps. */
  rating: number;
  /** Optional short plain text, ≤ 500 chars. */
  notes?: string | null;
}

export const REVIEW_NOTES_MAX = 500;

/** 1, 1.5, …, 5. */
export function isValidRating(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 5 && Number.isInteger(v * 2);
}

const ALLOWED = new Set([
  "specVersion", "kind", "network", "did", "submittedAt", "nonce", "buyer", "miner", "model", "modelHash",
  "channelId", "status", "ok", "settlementTx", "blockNumber", "maxFlop", "paidFlop", "promptTokens",
  "completionTokens", "latencyMs", "startedAt", "finishedAt", "errorClass", "promptHash", "outputHash", "endpointHash",
  "review",
]);
/** Fields the kit might carry that must never be submitted (SPEC §4 privacy, §7 agent auto-submit). */
const FORBIDDEN_HINT: Record<string, string> = {
  reply: "strip the reply text; submit outputHash instead",
  prompt: "submit promptHash, never the prompt",
  output: "submit outputHash, never the output",
  endpoint: "submit endpointHash, never the raw miner URL",
  url: "submit endpointHash, never the raw miner URL",
  mnemonic: "never submit wallet secrets",
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DECIMAL = /^(0|[1-9]\d{0,29})(\.\d{1,30})?$/;
const SHA256_TAGGED = /^sha256:[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{32}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  payload?: ReceiptPayload;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
}
const nonNegInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function validateReceiptPayload(p: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(p)) return { ok: false, errors: ["payload must be an object"] };

  for (const k of Object.keys(p)) {
    if (!ALLOWED.has(k)) errors.push(FORBIDDEN_HINT[k] ? `field '${k}' not allowed: ${FORBIDDEN_HINT[k]}` : `unknown field '${k}'`);
  }
  const opt = (k: string) => p[k] === undefined || p[k] === null;

  if (p.specVersion !== 1) errors.push("specVersion must be 1");
  if (p.kind !== "flop.miner-receipt") errors.push("kind must be 'flop.miner-receipt'");
  if (p.network !== "testnet" && p.network !== "devnet") errors.push("network must be 'testnet' or 'devnet'");
  if (!isDidKey(p.did)) errors.push("did must be an Ed25519 did:key");
  if (!isIso(p.submittedAt)) errors.push("submittedAt must be ISO-8601 UTC");
  if (typeof p.nonce !== "string" || !HEX128.test(p.nonce)) errors.push("nonce must be 128-bit lowercase hex");
  if (!isSs58(p.buyer)) errors.push("buyer must be a valid SS58 address");
  if (!isSs58(p.miner)) errors.push("miner must be a valid SS58 address");
  if (typeof p.model !== "string" || p.model.length < 1 || p.model.length > 200) errors.push("model must be a non-empty string");
  if (!opt("modelHash") && (typeof p.modelHash !== "string" || p.modelHash.length > 200)) errors.push("modelHash must be a string");
  if (!opt("channelId")) {
    const v = p.channelId;
    const okStr = typeof v === "string" && v.length >= 1 && v.length <= 200;
    if (!okStr && !nonNegInt(v)) errors.push("channelId must be a string or non-negative integer");
  }
  if (typeof p.status !== "string" || !(RECEIPT_STATUSES as readonly string[]).includes(p.status)) {
    errors.push(`status must be one of ${RECEIPT_STATUSES.join(", ")}`);
  }
  if (typeof p.ok !== "boolean") errors.push("ok must be boolean");
  else if (p.ok && p.status !== "settled") errors.push("ok=true requires status 'settled'");
  if (!opt("settlementTx") && (typeof p.settlementTx !== "string" || !TX_HASH.test(p.settlementTx))) {
    errors.push("settlementTx must be 0x + 64 hex");
  }
  if (!opt("blockNumber") && !nonNegInt(p.blockNumber)) errors.push("blockNumber must be a non-negative integer");
  if (typeof p.maxFlop !== "string" || !DECIMAL.test(p.maxFlop)) errors.push("maxFlop must be a decimal string");
  if (!opt("paidFlop") && (typeof p.paidFlop !== "string" || !DECIMAL.test(p.paidFlop))) errors.push("paidFlop must be a decimal string");
  for (const k of ["promptTokens", "completionTokens"]) if (!opt(k) && !nonNegInt(p[k])) errors.push(`${k} must be a non-negative integer`);
  if (!opt("latencyMs") && !(typeof p.latencyMs === "number" && Number.isFinite(p.latencyMs) && p.latencyMs >= 0 && p.latencyMs < 86_400_000)) {
    errors.push("latencyMs must be a non-negative number");
  }
  if (!isIso(p.startedAt)) errors.push("startedAt must be ISO-8601 UTC");
  if (!opt("finishedAt") && !isIso(p.finishedAt)) errors.push("finishedAt must be ISO-8601 UTC");
  if (!opt("errorClass") && !(ERROR_CLASSES as readonly unknown[]).includes(p.errorClass)) {
    errors.push(`errorClass must be one of ${ERROR_CLASSES.join(", ")}`);
  }
  if (typeof p.promptHash !== "string" || !SHA256_TAGGED.test(p.promptHash)) errors.push("promptHash must be 'sha256:' + 64 hex");
  for (const k of ["outputHash", "endpointHash"]) {
    if (!opt(k) && (typeof p[k] !== "string" || !SHA256_TAGGED.test(p[k] as string))) errors.push(`${k} must be 'sha256:' + 64 hex`);
  }
  const review = p.review;
  if (!isPlainObject(review)) {
    errors.push("review is required: { rating: 1–5 in 0.5 steps, notes?: string }");
  } else {
    for (const k of Object.keys(review)) if (k !== "rating" && k !== "notes") errors.push(`unknown review field '${k}'`);
    if (!isValidRating(review.rating)) errors.push("review.rating must be 1–5 in 0.5 steps (1, 1.5, … 5)");
    if (review.notes !== undefined && review.notes !== null) {
      if (typeof review.notes !== "string") errors.push("review.notes must be a string");
      else {
        if (review.notes.trim().length > REVIEW_NOTES_MAX) errors.push(`review.notes must be at most ${REVIEW_NOTES_MAX} characters`);
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(review.notes.trim())) errors.push("review.notes may not contain control characters (newlines are fine)");
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, payload: p as unknown as ReceiptPayload };
}

const FIVE_MIN = 5 * 60_000;
const SEVEN_DAYS = 7 * 86_400_000;

/** SPEC §6.1 freshness: submittedAt ≤ now+5m, and ≤ 7 days after finishedAt/startedAt. */
export function checkFreshness(p: ReceiptPayload, now = Date.now()): string | null {
  const submitted = Date.parse(p.submittedAt);
  const ref = Date.parse(p.finishedAt ?? p.startedAt);
  const started = Date.parse(p.startedAt);
  if (submitted > now + FIVE_MIN) return "submittedAt is in the future";
  if (submitted - ref > SEVEN_DAYS) return "submitted more than 7 days after the session";
  if (submitted + FIVE_MIN < ref) return "submittedAt is before the session finished";
  if (p.finishedAt && Date.parse(p.finishedAt) < started) return "finishedAt is before startedAt";
  if (now - submitted > SEVEN_DAYS) return "submittedAt is more than 7 days old";
  return null;
}
