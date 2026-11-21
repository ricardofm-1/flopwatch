import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getVerifier, VerifierConfigError } from "../src/verify";
import { RpcVerifier, extrinsicHash } from "../src/verify/rpc";
import type { Env } from "../src/env";
import type { ReceiptPayload } from "../src/receipts/schema";
import { makePayload, newKey } from "./helpers";

describe("mock verifier gate (acceptance 7)", () => {
  it("refuses the mock verifier when ALLOW_MOCK_VERIFIER is absent or not 'true'", () => {
    const base = { ...env, VERIFIER: "mock" } as unknown as Env;
    expect(() => getVerifier({ ...base, ALLOW_MOCK_VERIFIER: undefined })).toThrow(VerifierConfigError);
    expect(() => getVerifier({ ...base, ALLOW_MOCK_VERIFIER: "false" })).toThrow(VerifierConfigError);
    expect(() => getVerifier({ ...base, ALLOW_MOCK_VERIFIER: "TRUE " })).toThrow(VerifierConfigError);
    expect(getVerifier({ ...base, ALLOW_MOCK_VERIFIER: "true" }).name).toBe("mock");
  });

  it("production config (wrangler.toml) selects the rpc verifier", () => {
    expect(getVerifier({ ...env, VERIFIER: "rpc", ALLOW_MOCK_VERIFIER: "false" } as unknown as Env).name).toBe("rpc");
  });
});

describe("rpc verifier", () => {
  const ext = "0x280403000b" + "ab".repeat(20);
  const fakeRpc = (extrinsics: string[]) => async (_: RequestInfo, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    const result = method === "chain_getBlockHash" ? "0x" + "11".repeat(32) : { block: { extrinsics } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const payload = (over: Record<string, unknown>) => makePayload(newKey().did, over) as unknown as ReceiptPayload;

  it("passes on devnet when the settlement extrinsic is in the claimed block", async () => {
    const v = new RpcVerifier({ devnet: "https://rpc.example" }, fakeRpc([ext]));
    const r = await v.verify(payload({ network: "devnet", settlementTx: extrinsicHash(ext), blockNumber: 5 }));
    expect(r.outcome).toBe("passed");
  });

  it("fails when the extrinsic is absent", async () => {
    const v = new RpcVerifier({ devnet: "https://rpc.example" }, fakeRpc([ext]));
    const r = await v.verify(payload({ network: "devnet", settlementTx: "0x" + "00".repeat(32), blockNumber: 5 }));
    expect(r).toMatchObject({ outcome: "failed", note: "settlement_tx_not_in_block" });
  });

  it("never counts testnet until RPC and proof format are configured", async () => {
    const v = new RpcVerifier({ devnet: "https://rpc.example" }, fakeRpc([ext]));
    expect((await v.verify(payload({ network: "testnet" }))).outcome).toBe("unavailable");
    const v2 = new RpcVerifier({ testnet: "https://rpc.example" }, fakeRpc([ext]));
    const r = await v2.verify(payload({ network: "testnet", settlementTx: extrinsicHash(ext), blockNumber: 5 }));
    expect(r).toMatchObject({ outcome: "unavailable", note: "testnet_proof_format_pending" });
  });

  it("treats RPC outages as unavailable, not failed", async () => {
    const v = new RpcVerifier({ devnet: "https://rpc.example" }, async () => new Response("bad gateway", { status: 502 }));
    expect((await v.verify(payload({ network: "devnet" }))).outcome).toBe("unavailable");
  });
});
