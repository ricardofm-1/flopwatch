import { bytesToHex } from "../lib/encoding";
import { planckToFlop } from "../verify/rpc";
import type { ReviewPayload, Scores } from "./schema";

/**
 * Maps a @flop-labs/sdk (0.11.0+) runDirectSession result to a review payload, using only fields the
 * SDK typings confirm (FLOPWATCH-BUYER-REVIEWS-SPEC §5.1, §10). It never copies `reply`,
 * `receipts[].output` or `sessionSeed`, whatever the input contains.
 */
type Bytesish = string | Uint8Array | number[];
export interface DirectSessionResultLike {
  miner: string;
  channelId: Bytesish;
  settleTx?: Bytesish | null;
  settlement?: {
    channelId?: Bytesish;
    txHash?: Bytesish;
    /** Present only on SettledResult (cooperative settle or post-window finalize). Raw Planck. */
    minerPaid?: bigint | string | number;
    /** Present only on SettlementPostedResult (forceSettle, still in the challenge window). */
    finalRoot?: Bytesish;
    challengeEnd?: number;
  } | null;
}

export interface ReviewInput {
  network: "testnet" | "devnet";
  /** SS58 of the wallet that paid (the session signer). */
  buyer: string;
  model: string;
  modelHash?: string | null;
  scores: Scores;
  delivered: boolean;
  promptCategory?: ReviewPayload["promptCategory"];
  /** The agent's own wall-clock latency, if measured. Not the miner-claimed TurnReceipt.latencyMs. */
  latencyMs?: number | null;
  maxFlop?: string | null;
  notes?: string | null;
  flopwatchReceiptId?: string | null;
  blockNumber?: number | null;
}

function toHex32(v: Bytesish | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const h = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
    return /^[0-9a-fA-F]{64}$/.test(h) ? `0x${h.toLowerCase()}` : null;
  }
  const b = v instanceof Uint8Array ? v : Uint8Array.from(v);
  return b.length === 32 ? `0x${bytesToHex(b)}` : null;
}

export type DraftReview = Omit<ReviewPayload, "did" | "nonce" | "submittedAt">;

export function reviewFromSession(result: DirectSessionResultLike, input: ReviewInput): { payload: DraftReview; finalized: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const channelId = toHex32(result.channelId) ?? toHex32(result.settlement?.channelId);
  if (!channelId) throw new Error("result.channelId is not a 32-byte hash");
  const settlementTx = toHex32(result.settleTx) ?? toHex32(result.settlement?.txHash);
  const s = result.settlement ?? null;
  const finalized = !!s && s.minerPaid !== undefined && s.minerPaid !== null;
  if (!finalized) {
    warnings.push(
      s && (s.finalRoot !== undefined || s.challengeEnd !== undefined)
        ? "settlement is a SettlementPostedResult (challenge window open): no paidFlop; the review stays pending until the channel is Closed"
        : "no finalized settlement (minerPaid) on the result: no paidFlop",
    );
  }
  if (!settlementTx) warnings.push("no settlement tx on the result: the review can be stored but won't count");
  const payload: DraftReview = {
    specVersion: 1,
    kind: "flop.miner-review",
    network: input.network,
    buyer: input.buyer,
    miner: result.miner,
    model: input.model,
    ...(input.modelHash ? { modelHash: input.modelHash } : {}),
    channelId,
    ...(settlementTx ? { settlementTx } : {}),
    ...(input.blockNumber != null ? { blockNumber: input.blockNumber } : {}),
    scores: input.scores,
    delivered: input.delivered,
    ...(input.promptCategory ? { promptCategory: input.promptCategory } : {}),
    ...(input.latencyMs != null ? { latencyMs: input.latencyMs } : {}),
    ...(finalized ? { paidFlop: planckToFlop(s!.minerPaid as bigint | string | number) } : {}),
    ...(input.maxFlop ? { maxFlop: input.maxFlop } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.flopwatchReceiptId ? { flopwatchReceiptId: input.flopwatchReceiptId } : {}),
  };
  return { payload, finalized, warnings };
}
