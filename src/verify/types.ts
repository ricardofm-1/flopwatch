import type { ReceiptPayload } from "../receipts/schema";
import type { SessionCheck, SessionCheckInput } from "./rpc";

export type VerifyOutcome =
  | { outcome: "passed"; note?: string }
  | { outcome: "failed"; note: string }
  /** Could not decide now (RPC down, slow, or not yet configured). Never counts; retry later. */
  | { outcome: "unavailable"; note: string };

export interface ChainVerifier {
  readonly name: string;
  /** True when this verifier can ever reach a decision for the network (used to skip pointless retries). */
  canVerify(network: ReceiptPayload["network"]): boolean;
  verify(payload: ReceiptPayload, signal?: AbortSignal): Promise<VerifyOutcome>;
  /** Review path: load + match the on-chain channel (see RpcVerifier.checkSession). */
  checkSession(input: SessionCheckInput, signal?: AbortSignal): Promise<SessionCheck>;
}
