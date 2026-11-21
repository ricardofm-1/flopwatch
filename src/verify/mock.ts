import type { ChainVerifier, VerifyOutcome } from "./types";
import type { ReceiptPayload } from "../receipts/schema";

/**
 * Development-only verifier. Never trusts the chain because it never asks it.
 * Construction is refused unless ALLOW_MOCK_VERIFIER === "true" (see ./index.ts).
 * Behaviour: passes when the receipt references a channel or settlement tx;
 * channelId "mock-unavailable" simulates an RPC outage (202 path).
 */
export class MockVerifier implements ChainVerifier {
  readonly name = "mock";
  canVerify(): boolean {
    return true;
  }
  async verify(p: ReceiptPayload): Promise<VerifyOutcome> {
    if (p.channelId === "mock-unavailable") return { outcome: "unavailable", note: "mock: simulated RPC outage" };
    if (p.channelId == null && !p.settlementTx) return { outcome: "failed", note: "no_onchain_reference" };
    return { outcome: "passed", note: "mock verifier (not a chain check)" };
  }
}
