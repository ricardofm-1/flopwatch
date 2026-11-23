import { describe, expect, it } from "vitest";
import { RpcVerifier, channelsStorageKey, decodeChannel, flopToPlanck } from "../src/verify/rpc";
import { ss58Encode } from "../src/did/ss58";
import type { ReceiptPayload } from "../src/receipts/schema";
import { envelope, login, makePayload, newKey, submit, uniqueIp } from "./helpers";

/**
 * Real computeChannel.channels entry read from FLOP Devnet (rpc.devnet.flop.network) on 2026-11-23,
 * cross-checked with @polkadot/api against the chain's own metadata:
 * agent 5Df3aJ1S…, miner 5CaNZhyq…, escrow 0.05 FLOP, openedAt 3,795,682, state Closed.
 */
const KEY =
  "0x130ba67ef498736437f36679a246a7547759ccc18de172078306ca5973251a7b00018147c16575cdec50a6f786fdbedb6361bc6105f187cb73b2e78f08aa8ad81252a8034113e15ef9a0da313f268b95";
const RAW =
  "0x466cf3ec109ed511985e58a94d26ae82286676fcf69a94042102078d5d58c55c16a06b01d0f0b1588743b1db957cd241726adaf2273ae275bd5697413ff36a3ffab8ec57f3bc1b5d4ca644fe12fab2ca1c35c24697d577c610b382cfea14d52dfab8ec57f3bc1b5d4ca644fe12fab2ca1c35c24697d577c610b382cfea14d52d02e8eeb1b0a731bfe2b7dfd51f83e56d00bd1a8cbbe8d011729b51adc5fa9ad9316e976448ef9ec6740841177efb2bdd4a124e8ee59095ec94d489d1da7b0146660000c52ebca2b100000000000000000003000000ea36000000000000c65d2c7e238de8eae2ea3900e2ea3900020001712e4ca136a931857ed585a6a43b1bee893f26953df74522bfe9383352e0e8ae00000000000000000000000000000000";
const CHANNEL_ID = "0x" + KEY.slice(-64);
const AGENT = "5Df3aJ1SfM5VGtNLxDx2AiBNqcYP5vetqZ4H8hWf6ka6CqPh";
const MINER = "5CaNZhyqPSYq6bQZHUe5YLbkxEasw7FWH46nQStEJtQSdB3W";
const MODEL_HASH = "0xfab8ec57f3bc1b5d4ca644fe12fab2ca1c35c24697d577c610b382cfea14d52d";
// State byte offset: 3×32 + 32 + 1 + 32 + 32 + 16 + 12 + 8 + 4 + 4 = 237.
const withState = (idx: number) => RAW.slice(0, 2 + 237 * 2) + idx.toString(16).padStart(2, "0") + RAW.slice(2 + 238 * 2);

function fakeRpc(storage: string | null) {
  const calls: string[] = [];
  const fetchFn = async (_: RequestInfo, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    const result = method === "state_getStorage" ? (params[0] === KEY ? storage : null) : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { fetchFn, calls };
}

const receipt = (over: Record<string, unknown> = {}) =>
  makePayload(newKey().did, {
    network: "devnet", buyer: AGENT, miner: MINER, modelHash: MODEL_HASH, channelId: CHANNEL_ID,
    settlementTx: null, blockNumber: null, maxFlop: "0.05", paidFlop: "0.031", status: "settled", ok: true, ...over,
  }) as unknown as ReceiptPayload;

describe("computeChannel.channels decoding (real devnet record)", () => {
  it("derives the Blake2_128Concat storage key", () => {
    expect(channelsStorageKey(CHANNEL_ID)).toBe(KEY);
    expect(() => channelsStorageKey("0x1234")).toThrow();
  });

  it("decodes agent, miner, model hash, escrow, openedAt and state", () => {
    const ch = decodeChannel(RAW);
    expect(ss58Encode(ch.agent)).toBe(AGENT);
    expect(ss58Encode(ch.miner)).toBe(MINER);
    expect("0x" + Buffer.from(ch.modelHash).toString("hex")).toBe(MODEL_HASH);
    expect(ch.escrowPlanck).toBe(50_000_000_000_000_000n);
    expect(ch.openedAtBlock).toBe(3_795_682);
    expect(ch.state).toBe("Closed");
    expect(decodeChannel(withState(0)).state).toBe("Open");
    expect(() => decodeChannel(withState(9))).toThrow(/unknown channel state/);
    expect(() => decodeChannel(RAW.slice(0, 200))).toThrow(/truncated/);
  });

  it("converts decimal FLOP to planck at 18 decimals", () => {
    expect(flopToPlanck("0.05")).toBe(50_000_000_000_000_000n);
    expect(flopToPlanck("1")).toBe(10n ** 18n);
    expect(flopToPlanck("0.0000000000000000001")).toBeNull();
    expect(flopToPlanck("abc")).toBeNull();
  });
});

describe("RpcVerifier channel matching", () => {
  const verify = (p: ReceiptPayload, storage: string | null = RAW) =>
    new RpcVerifier({ devnet: "https://rpc.example", testnet: "https://rpc.example" }, fakeRpc(storage).fetchFn).verify(p);

  it("passes when buyer, miner, model hash, Closed state and escrow all match", async () => {
    expect(await verify(receipt())).toMatchObject({ outcome: "passed", note: "channel_fields_match:Closed" });
  });

  it("verifies testnet receipts by channel (no longer stuck pending)", async () => {
    expect((await verify(receipt({ network: "testnet" }))).outcome).toBe("passed");
  });

  it("accepts an honest failure on a real channel", async () => {
    const r = await verify(receipt({ status: "failed", ok: false, errorClass: "miner-unreachable", paidFlop: null }), withState(0));
    expect(r.outcome).toBe("passed");
  });

  it.each([
    [{ buyer: MINER }, "buyer_mismatch"],
    [{ miner: AGENT }, "miner_mismatch"],
    [{ modelHash: "0x" + "00".repeat(32) }, "model_hash_mismatch"],
    [{ maxFlop: "0.01" }, "escrow_mismatch"],
    [{ paidFlop: "0.06" }, "paid_exceeds_escrow"],
  ])("fails on %o", async (over, note) => {
    expect(await verify(receipt(over))).toMatchObject({ outcome: "failed", note });
  });

  it("fails a settled receipt whose channel is not Closed", async () => {
    expect(await verify(receipt(), withState(0))).toMatchObject({ outcome: "failed", note: "channel_not_closed:Open" });
  });

  it("fails when the channel does not exist", async () => {
    expect(await verify(receipt(), null)).toMatchObject({ outcome: "failed", note: "channel_not_found" });
  });

  it("is unavailable (retry later) when the record can't be decoded", async () => {
    expect((await verify(receipt(), withState(9))).outcome).toBe("unavailable");
  });

  it("only queries channel storage when there is no settlementTx + blockNumber", async () => {
    const { fetchFn, calls } = fakeRpc(RAW);
    await new RpcVerifier({ devnet: "https://rpc.example" }, fetchFn).verify(receipt());
    expect(calls).toEqual(["state_getStorage"]);
  });
});

describe("one receipt per on-chain channel", () => {
  it("rejects a second receipt for the same channel, whatever the case", async () => {
    const ip = uniqueIp();
    const key = newKey();
    const token = await login(key, ip);
    const ch = "0x" + "ab".repeat(32);
    const first = await submit(token, envelope(key, makePayload(key.did, { channelId: ch, settlementTx: null, blockNumber: null })), ip);
    expect(first.status).toBe(201);
    const again = await submit(token, envelope(key, makePayload(key.did, { channelId: ch.toUpperCase().replace("0X", "0x"), settlementTx: null, blockNumber: null })), ip);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("duplicate_channel");
    // Non-hash channel labels (samples, mocks) are not treated as on-chain ids.
    const a = await submit(token, envelope(key, makePayload(key.did, { channelId: "ch-label", settlementTx: null, blockNumber: null })), ip);
    const b = await submit(token, envelope(key, makePayload(key.did, { channelId: "ch-label", settlementTx: null, blockNumber: null })), ip);
    expect([a.status, b.status]).toEqual([201, 201]);
  });
});
