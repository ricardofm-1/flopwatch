import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getVerifier, VerifierConfigError } from "../src/verify";
import { KNOWN_GENESIS, RpcVerifier, extrinsicHash } from "../src/verify/rpc";
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
    // This fake serves block hash 0x11… for every height, i.e. not the official testnet genesis.
    const v2 = new RpcVerifier({ testnet: "https://rpc.example" }, fakeRpc([ext]));
    const r = await v2.verify(payload({ network: "testnet", settlementTx: extrinsicHash(ext), blockNumber: 5 }));
    expect(r).toMatchObject({ outcome: "unavailable", note: "genesis_mismatch:testnet" });
    const v3 = new RpcVerifier({ testnet: "https://rpc.example" }, fakeRpc([ext]), { testnet: "0x" + "11".repeat(32) });
    const r3 = await v3.verify(payload({ network: "testnet", settlementTx: extrinsicHash(ext), blockNumber: 5 }));
    expect(r3).toMatchObject({ outcome: "unavailable", note: "testnet_proof_format_pending" });
  });

  it("treats a testnet RPC serving another chain as untrusted (receipts and reviews)", async () => {
    expect(KNOWN_GENESIS.testnet).toBe("0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800");
    const v = new RpcVerifier({ testnet: "https://evil.example" }, fakeRpc([ext]));
    const s = await v.checkSession({ network: "testnet", buyer: payload({}).buyer, miner: payload({}).miner, channelId: "0x" + "ab".repeat(32) });
    expect(s).toMatchObject({ outcome: "unavailable", note: "genesis_mismatch:testnet" });
  });

  it("treats RPC outages as unavailable, not failed", async () => {
    const v = new RpcVerifier({ devnet: "https://rpc.example" }, async () => new Response("bad gateway", { status: 502 }));
    expect((await v.verify(payload({ network: "devnet" }))).outcome).toBe("unavailable");
  });
});
