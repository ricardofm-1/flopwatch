import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { requeueUnconfigured } from "../src/jobs";

describe("requeueUnconfigured", () => {
  it("queues only receipts left pending because the RPC wasn't configured, once", async () => {
    const ins = (id: string, note: string, verification = "pending_verification") =>
      env.DB.prepare(
        `INSERT INTO receipts (id, network, did, buyer, miner, model, status, ok, max_flop, started_at, submitted_at, nonce,
          payload_json, signature, received_at, verification, verification_note)
         VALUES (?, 'testnet', 'did:key:x', 'b', 'm', 'model', 'settled', 1, '0.05', '2026-11-25T10:00:00Z', '2026-11-25T10:00:01Z', ?, '{}', 's', ?, ?, ?)`,
      ).bind(id, "n-" + id, Date.now(), verification, note).run();
    await ins("rq-a", "rpc_not_configured:testnet");
    await ins("rq-b", "rpc http 502");
    await ins("rq-c", "rpc_not_configured:testnet", "passed");
    expect(await requeueUnconfigured(env)).toBe(1); // test env uses the mock verifier, which can verify every network
    const a = await env.DB.prepare("SELECT verification_note FROM receipts WHERE id = 'rq-a'").first<{ verification_note: string }>();
    expect(a!.verification_note).toBe("queued_for_verification");
    expect(await requeueUnconfigured(env)).toBe(0); // not queued twice
  });
});
