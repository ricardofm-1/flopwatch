import { blake2b } from "@noble/hashes/blake2.js";
import type { ChainVerifier, VerifyOutcome } from "./types";
import type { ReceiptPayload } from "../receipts/schema";
import { bytesToHex, hexToBytes } from "../lib/encoding";

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
 * Lean on-chain check against a public Flop HTTP RPC.
 *
 * Phase 0 checks what is knowable without the (still unpublished) proof format:
 * the settlement extrinsic is included in the claimed block. Matching buyer / miner /
 * model against decoded call args or events is SPEC §11.2 and is deliberately left as
 * `matchProofFields`, which returns "unavailable" on testnet until implemented, so
 * nothing on testnet counts without a full check.
 */
export class RpcVerifier implements ChainVerifier {
  readonly name = "rpc";
  constructor(
    private rpcUrls: Partial<Record<ReceiptPayload["network"], string>>,
    private fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}

  canVerify(network: ReceiptPayload["network"]): boolean {
    return !!this.rpcUrls[network];
  }

  async verify(p: ReceiptPayload, signal?: AbortSignal): Promise<VerifyOutcome> {
    const url = this.rpcUrls[p.network];
    if (!url) return { outcome: "unavailable", note: `rpc_not_configured:${p.network}` };
    if (p.channelId == null && !p.settlementTx) return { outcome: "failed", note: "no_onchain_reference" };
    if (!p.settlementTx || p.blockNumber == null) {
      return { outcome: "unavailable", note: "channel_lookup_not_implemented (needs settlementTx + blockNumber)" };
    }
    try {
      const blockHash = await rpcCall<string | null>(this.fetchFn, url, "chain_getBlockHash", [p.blockNumber], signal);
      if (!blockHash) return { outcome: "unavailable", note: "block_not_found_yet" };
      const block = await rpcCall<{ block: { extrinsics: string[] } } | null>(this.fetchFn, url, "chain_getBlock", [blockHash], signal);
      if (!block) return { outcome: "unavailable", note: "block_not_found_yet" };
      const want = p.settlementTx.toLowerCase();
      const found = block.block.extrinsics.some((x) => extrinsicHash(x) === want);
      if (!found) return { outcome: "failed", note: "settlement_tx_not_in_block" };
      return this.matchProofFields(p);
    } catch (e) {
      return { outcome: "unavailable", note: e instanceof RpcError ? e.message : "rpc_error" };
    }
  }

  /** SPEC §11.2 — fill in once ComputeChannel / MeteringVerifier event shapes are published. */
  protected matchProofFields(p: ReceiptPayload): VerifyOutcome {
    if (p.network === "devnet") return { outcome: "passed", note: "devnet: inclusion only" };
    return { outcome: "unavailable", note: "testnet_proof_format_pending" };
  }
}
