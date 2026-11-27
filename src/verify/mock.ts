import type { ChainVerifier, VerifyOutcome } from "./types";
import { flopToPlanck, type SessionCheck, type SessionCheckInput } from "./rpc";
import type { ReceiptPayload } from "../receipts/schema";

/**
 * Development-only verifier. Never trusts the chain because it never asks it.
 * Construction is refused unless ALLOW_MOCK_VERIFIER === "true" (see ./index.ts).
 * Behaviour: passes when the receipt references a channel or settlement tx;
 * channelId "mock-unavailable" simulates an RPC outage (202 path).
 * Reviews: a channel id starting 0xdead → channel_not_found; 0x0e (state Open) → not yet Closed;
 * anything else is a Closed channel opened an hour ago.
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

  async checkSession(input: SessionCheckInput): Promise<SessionCheck> {
    const id = input.channelId.toLowerCase();
    if (id.startsWith("0xdead")) return { outcome: "failed", note: "channel_not_found" };
    const escrow = flopToPlanck(input.maxFlop ?? "1") ?? 10n ** 18n;
    return {
      outcome: "found",
      state: id.startsWith("0x0e") ? "Open" : "Closed",
      escrowPlanck: escrow,
      openedAtBlock: 1,
      openedAtMs: Date.now() - 3_600_000,
      inclusionChecked: false,
      note: "mock verifier (not a chain check)",
    };
  }
}
