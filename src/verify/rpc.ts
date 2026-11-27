import { blake2b } from "@noble/hashes/blake2.js";
import type { ChainVerifier, VerifyOutcome } from "./types";
import type { ReceiptPayload } from "../receipts/schema";
import { bytesToHex, hexToBytes } from "../lib/encoding";
import { ss58Decode } from "../did/ss58";

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export class RpcError extends Error {}

/** Minimal Substrate HTTP JSON-RPC client (no @polkadot/api: stays inside 10 ms CPU). */
export async function rpcCall<T>(fetchFn: FetchFn, url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
  } catch (e) {
    throw new RpcError(`rpc unreachable: ${(e as Error).name}`);
  }
  if (!res.ok) throw new RpcError(`rpc http ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new RpcError(`rpc error: ${body.error.message ?? "unknown"}`);
  return body.result as T;
}

/** Substrate extrinsic hash = blake2b-256 of the SCALE-encoded extrinsic bytes. */
export function extrinsicHash(extrinsicHex: string): string {
  return "0x" + bytesToHex(blake2b(hexToBytes(extrinsicHex), { dkLen: 32 }));
}

/**
 * twox128("ComputeChannel") || twox128("Channels") — constant pallet prefix from
 * current FLOP metadata (ComputeChannel::Channels, Blake2_128Concat hasher).
 */
const CHANNELS_PREFIX = hexToBytes("0x130ba67ef498736437f36679a246a7547759ccc18de172078306ca5973251a7b");

const CHANNEL_STATE = ["Open", "Settling", "Closed", "PendingAck"] as const;
export type ChannelStateName = (typeof CHANNEL_STATE)[number];

export interface DecodedChannel {
  agent: Uint8Array;
  miner: Uint8Array;
  modelHash: Uint8Array;
  escrowPlanck: bigint;
  openedAtBlock: number;
  state: ChannelStateName;
}

/** Storage key for computeChannel.channels(channelId). channelId is a 32-byte hash. */
export function channelsStorageKey(channelIdHex: string): string {
  const id = hexToBytes(channelIdHex);
  if (id.length !== 32) throw new Error("channelId must be a 32-byte hex hash");
  const h = blake2b(id, { dkLen: 16 });
  const key = new Uint8Array(CHANNELS_PREFIX.length + 16 + 32);
  key.set(CHANNELS_PREFIX, 0);
  key.set(h, CHANNELS_PREFIX.length);
  key.set(id, CHANNELS_PREFIX.length + 16);
  return "0x" + bytesToHex(key);
}

function take(b: Uint8Array, o: { i: number }, n: number): Uint8Array {
  if (o.i + n > b.length) throw new Error("channel SCALE truncated");
  const s = b.subarray(o.i, o.i + n);
  o.i += n;
  return s;
}

function u32le(b: Uint8Array): number {
  return (b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24);
}

function u128le(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = 15; i >= 0; i--) x = (x << 8n) + BigInt(b[i] ?? 0);
  return x;
}

/** Decode PalletComputeChannelChannel enough to match SPEC §11.2 fields. */
export function decodeChannel(rawHex: string): DecodedChannel {
  const b = hexToBytes(rawHex);
  const o = { i: 0 };
  const agent = take(b, o, 32);
  const miner = take(b, o, 32);
  const modelHash = take(b, o, 32);
  take(b, o, 32); // measuredRoot
  take(b, o, 1); // precision (ModelPrecision enum, unit variants)
  take(b, o, 32); // enclaveKey
  take(b, o, 32); // agentKey
  const escrowPlanck = u128le(take(b, o, 16));
  take(b, o, 12); // sla {maxTurns, maxDuration, reattestEvery} u32×3
  take(b, o, 8); // nonce u64
  const openedAtBlock = u32le(take(b, o, 4));
  take(b, o, 4); // lastAttestedAt
  const stateIdx = take(b, o, 1)[0] ?? 255;
  const state = CHANNEL_STATE[stateIdx];
  if (!state) throw new Error(`unknown channel state index ${stateIdx}`);
  // Remaining variant payloads / options are not needed for matching.
  if (state === "Settling") take(b, o, 32 + 16 + 4);
  else if (state === "PendingAck") take(b, o, 4);
  return { agent, miner, modelHash, escrowPlanck, openedAtBlock, state };
}

const FLOP_DECIMALS = 18;

/** Parse a decimal FLOP string into Planck (10^18). Null if unparsable or too many fraction digits. */
export function flopToPlanck(dec: string, decimals = FLOP_DECIMALS): bigint | null {
  if (typeof dec !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(dec)) return null;
  const [w, f = ""] = dec.split(".");
  if (f.length > decimals && f.slice(decimals).replace(/0/g, "") !== "") return null;
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w + frac);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return x === 0;
}

function sameAccount(ss58: string, raw: Uint8Array): boolean {
  try {
    return sameBytes(ss58Decode(ss58).publicKey, raw);
  } catch {
    return false;
  }
}

function sameHash(hex: string, raw: Uint8Array): boolean {
  try {
    const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex : `0x${hex}`;
    return sameBytes(hexToBytes(h), raw);
  } catch {
    return false;
  }
}

/** Official genesis hashes. An RPC that doesn't serve this exact chain is untrusted (SPEC reviews §4, §7.4). */
export const KNOWN_GENESIS: Partial<Record<ReceiptPayload["network"], string>> = {
  // flop.finance/testnet, checked 2026-11-26.
  testnet: "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800",
};

/** twox128("Timestamp") ++ twox128("Now"): identical on Devnet and Testnet metadata (checked 2026-11-27). */
const TIMESTAMP_NOW_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";

/** Per-isolate memo of RPC URLs whose genesis matched; mismatches are re-checked every time. */
const genesisVerified = new Set<string>();

export interface SessionCheckInput {
  network: ReceiptPayload["network"];
  buyer: string;
  miner: string;
  modelHash?: string | null;
  channelId: string;
  settlementTx?: string | null;
  blockNumber?: number | null;
  maxFlop?: string | null;
  paidFlop?: string | null;
}

export type SessionCheck =
  | { outcome: "unavailable"; note: string }
  | { outcome: "failed"; note: string }
  | {
      outcome: "found";
      state: ChannelStateName;
      escrowPlanck: bigint;
      openedAtBlock: number;
      /** Block timestamp (ms) of the channel's opened_at block, for review freshness. */
      openedAtMs: number;
      inclusionChecked: boolean;
      note: string;
    };

/**
 * Lean on-chain check against a public Flop HTTP RPC.
 *
 * Checks (when the receipt supplies the data):
 *  0. testnet only: the RPC serves the official genesis
 *  1. settlement extrinsic is included in the claimed block (needs settlementTx + blockNumber)
 *  2. computeChannel.channels(channelId) exists and matches buyer / miner / modelHash /
 *     Closed (for settled) and escrow (maxFlop)
 *
 * Either a channelId or (settlementTx + blockNumber) is enough to attempt a decision.
 * SDK SettledResult has txHash + channelId but not blockNumber; channel storage covers that path.
 */
export class RpcVerifier implements ChainVerifier {
  readonly name = "rpc";
  constructor(
    private rpcUrls: Partial<Record<ReceiptPayload["network"], string>>,
    private fetchFn: FetchFn = (i, init) => fetch(i, init),
    private genesis: Partial<Record<ReceiptPayload["network"], string>> = KNOWN_GENESIS,
  ) {}

  canVerify(network: ReceiptPayload["network"]): boolean {
    return !!this.rpcUrls[network];
  }

  /** Returns null when trusted, or an "unavailable" outcome when the RPC serves a different chain. */
  private async checkGenesis(network: ReceiptPayload["network"], url: string, signal?: AbortSignal): Promise<VerifyOutcome | null> {
    const want = this.genesis[network];
    if (!want || genesisVerified.has(`${network}|${url}|${want}`)) return null;
    const got = await rpcCall<string | null>(this.fetchFn, url, "chain_getBlockHash", [0], signal);
    if (typeof got !== "string" || got.toLowerCase() !== want.toLowerCase()) {
      console.error(`genesis mismatch on ${network} RPC`);
      return { outcome: "unavailable", note: `genesis_mismatch:${network}` };
    }
    genesisVerified.add(`${network}|${url}|${want}`);
    return null;
  }

  private async checkInclusion(url: string, settlementTx: string, blockNumber: number, signal?: AbortSignal): Promise<VerifyOutcome | null> {
    const blockHash = await rpcCall<string | null>(this.fetchFn, url, "chain_getBlockHash", [blockNumber], signal);
    if (!blockHash) return { outcome: "unavailable", note: "block_not_found_yet" };
    const block = await rpcCall<{ block: { extrinsics: string[] } } | null>(this.fetchFn, url, "chain_getBlock", [blockHash], signal);
    if (!block) return { outcome: "unavailable", note: "block_not_found_yet" };
    const want = settlementTx.toLowerCase();
    if (!block.block.extrinsics.some((x) => extrinsicHash(x) === want)) return { outcome: "failed", note: "settlement_tx_not_in_block" };
    return null;
  }

  private async loadChannel(url: string, channelId: string, signal?: AbortSignal): Promise<DecodedChannel | VerifyOutcome> {
    let key: string;
    try {
      key = channelsStorageKey(channelId);
    } catch {
      return { outcome: "failed", note: "channel_id_not_a_32_byte_hash" };
    }
    const raw = await rpcCall<string | null>(this.fetchFn, url, "state_getStorage", [key], signal);
    if (!raw) return { outcome: "failed", note: "channel_not_found" };
    try {
      return decodeChannel(raw);
    } catch (e) {
      return { outcome: "unavailable", note: `channel_decode_failed: ${(e as Error).message}` };
    }
  }

  async verify(p: ReceiptPayload, signal?: AbortSignal): Promise<VerifyOutcome> {
    const url = this.rpcUrls[p.network];
    if (!url) return { outcome: "unavailable", note: `rpc_not_configured:${p.network}` };
    if (p.channelId == null && !p.settlementTx) return { outcome: "failed", note: "no_onchain_reference" };

    const haveInclusionInputs = !!p.settlementTx && p.blockNumber != null;
    const haveChannel = typeof p.channelId === "string" && /^0x[0-9a-fA-F]{64}$/.test(p.channelId);
    if (!haveInclusionInputs && !haveChannel) {
      return { outcome: "unavailable", note: "channel_lookup_needs_channelId_or_settlementTx_and_blockNumber" };
    }

    try {
      const untrusted = await this.checkGenesis(p.network, url, signal);
      if (untrusted) return untrusted;
      const notes: string[] = [];
      if (haveInclusionInputs) {
        const inc = await this.checkInclusion(url, p.settlementTx!, p.blockNumber!, signal);
        if (inc) return inc;
        notes.push("inclusion");
      }

      if (haveChannel) {
        const field = await this.matchProofFields(p, url, signal);
        if (field.outcome !== "passed") return field;
        if (field.note) notes.push(field.note);
        return { outcome: "passed", note: notes.join("; ") };
      }

      // Inclusion passed but no channelId to match against storage.
      if (p.network === "devnet") return { outcome: "passed", note: "devnet: inclusion only (no channelId)" };
      return { outcome: "unavailable", note: "testnet_proof_format_pending" };
    } catch (e) {
      return { outcome: "unavailable", note: e instanceof RpcError ? e.message : "rpc_error" };
    }
  }

  /** SPEC §11.2 — compare receipt fields to computeChannel.channels(channelId). */
  protected async matchProofFields(p: ReceiptPayload, url: string, signal?: AbortSignal): Promise<VerifyOutcome> {
    const ch = await this.loadChannel(url, String(p.channelId), signal);
    if ("outcome" in ch) return ch;

    if (!sameAccount(p.buyer, ch.agent)) return { outcome: "failed", note: "buyer_mismatch" };
    if (!sameAccount(p.miner, ch.miner)) return { outcome: "failed", note: "miner_mismatch" };
    if (p.modelHash && !sameHash(p.modelHash, ch.modelHash)) return { outcome: "failed", note: "model_hash_mismatch" };

    const settled = p.ok === true || p.status === "settled";
    if (settled && ch.state !== "Closed") {
      return { outcome: "failed", note: `channel_not_closed:${ch.state}` };
    }

    const maxPlanck = flopToPlanck(p.maxFlop);
    if (maxPlanck == null) return { outcome: "failed", note: "max_flop_unparsable" };
    if (maxPlanck !== ch.escrowPlanck) return { outcome: "failed", note: "escrow_mismatch" };

    // minerPaid lives on the Settled event, not in Channel storage, so paidFlop
    // can only be bounded by escrow here.
    if (p.paidFlop != null && p.paidFlop !== "") {
      const paid = flopToPlanck(p.paidFlop);
      if (paid == null) return { outcome: "failed", note: "paid_flop_unparsable" };
      if (paid > ch.escrowPlanck) return { outcome: "failed", note: "paid_exceeds_escrow" };
    }

    return { outcome: "passed", note: `channel_fields_match:${ch.state}` };
  }

  /**
   * Review path (FLOPWATCH-BUYER-REVIEWS-SPEC §7.4): channel storage is the proof; block number is optional.
   * Does not decide "counted": the caller applies Closed / settlementTx / caps. Never invents minerPaid.
   */
  async checkSession(input: SessionCheckInput, signal?: AbortSignal): Promise<SessionCheck> {
    const url = this.rpcUrls[input.network];
    if (!url) return { outcome: "unavailable", note: `rpc_not_configured:${input.network}` };
    try {
      const untrusted = await this.checkGenesis(input.network, url, signal);
      if (untrusted) return untrusted as SessionCheck;
      let inclusionChecked = false;
      if (input.settlementTx && input.blockNumber != null) {
        const inc = await this.checkInclusion(url, input.settlementTx, input.blockNumber, signal);
        if (inc) return inc as SessionCheck;
        inclusionChecked = true;
      }
      const ch = await this.loadChannel(url, input.channelId, signal);
      if ("outcome" in ch) return ch as SessionCheck;
      if (!sameAccount(input.buyer, ch.agent)) return { outcome: "failed", note: "buyer_mismatch" };
      if (!sameAccount(input.miner, ch.miner)) return { outcome: "failed", note: "miner_mismatch" };
      if (input.modelHash && !sameHash(input.modelHash, ch.modelHash)) return { outcome: "failed", note: "model_hash_mismatch" };
      if (input.maxFlop != null) {
        const max = flopToPlanck(input.maxFlop);
        if (max == null) return { outcome: "failed", note: "max_flop_unparsable" };
        if (max !== ch.escrowPlanck) return { outcome: "failed", note: "escrow_mismatch" };
      }
      if (input.paidFlop != null) {
        const paid = flopToPlanck(input.paidFlop);
        if (paid == null) return { outcome: "failed", note: "paid_flop_unparsable" };
        if (paid > ch.escrowPlanck) return { outcome: "failed", note: "paid_exceeds_escrow" };
      }
      const openedHash = await rpcCall<string | null>(this.fetchFn, url, "chain_getBlockHash", [ch.openedAtBlock], signal);
      const tsRaw = openedHash ? await rpcCall<string | null>(this.fetchFn, url, "state_getStorage", [TIMESTAMP_NOW_KEY, openedHash], signal) : null;
      const tsBytes = tsRaw ? hexToBytes(tsRaw) : null;
      if (!tsBytes || tsBytes.length !== 8) return { outcome: "unavailable", note: "opened_at_timestamp_unavailable" };
      let openedAtMs = 0;
      for (let i = 7; i >= 0; i--) openedAtMs = openedAtMs * 256 + (tsBytes[i] ?? 0);
      return {
        outcome: "found",
        state: ch.state,
        escrowPlanck: ch.escrowPlanck,
        openedAtBlock: ch.openedAtBlock,
        openedAtMs,
        inclusionChecked,
        note: `${inclusionChecked ? "inclusion; " : ""}channel_fields_match:${ch.state}`,
      };
    } catch (e) {
      return { outcome: "unavailable", note: e instanceof RpcError ? e.message : "rpc_error" };
    }
  }
}

/** Planck (10^-18 FLOP) → exact decimal string, no floats. "42500000000000000" → "0.0425". */
export function planckToFlop(planck: bigint | string | number, decimals = FLOP_DECIMALS): string {
  const v = BigInt(planck);
  if (v < 0n) throw new Error("negative amount");
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
