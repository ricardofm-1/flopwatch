import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { didKeyToPublicKey, publicKeyToDidKey, verifyDidSignature, isDidKey } from "../src/did/didkey";
import { jcs, jcsBytes } from "../src/receipts/jcs";
import { isSs58, ss58Encode } from "../src/did/ss58";
import { utf8 } from "../src/lib/encoding";

describe("did:key (acceptance 1)", () => {
  it("round-trips an Ed25519 key and verifies a signature", async () => {
    const sk = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(sk);
    const did = publicKeyToDidKey(pub);
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    expect(didKeyToPublicKey(did)).toEqual(pub);
    const msg = utf8.encode("hello flop");
    const sig = ed25519.sign(msg, sk);
    expect(await verifyDidSignature(did, msg, sig)).toBe(true);
    expect(await verifyDidSignature(did, utf8.encode("hello flip"), sig)).toBe(false);
    const other = publicKeyToDidKey(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    expect(await verifyDidSignature(other, msg, sig)).toBe(false);
  });

  it("parses the agent DID from the spec", () => {
    expect(isDidKey("did:key:z6Mkpo9ua8PapGhF8XHA6N4RsA2ZRVKJQz7niHo97PHtofGa")).toBe(true);
  });

  it("rejects non-Ed25519 or malformed did:key", () => {
    // secp256k1 did:key (multicodec 0xe7)
    expect(isDidKey("did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme")).toBe(false);
    expect(isDidKey("did:web:example.com")).toBe(false);
    expect(isDidKey("did:key:z6Mk0OIl")).toBe(false);
  });
});

describe("JCS", () => {
  it("canonicalizes key order and number forms (RFC 8785)", () => {
    expect(jcs({ b: 1, a: [true, null, 1e21, 0.5], c: { z: "é", y: 1.0 } })).toBe('{"a":[true,null,1e+21,0.5],"b":1,"c":{"y":1,"z":"é"}}');
    expect(jcsBytes({ b: 2, a: 1 })).toEqual(utf8.encode('{"a":1,"b":2}'));
  });
});

describe("ss58", () => {
  it("encodes and validates checksums", () => {
    const a = ss58Encode(new Uint8Array(32).fill(1));
    expect(isSs58(a)).toBe(true);
    expect(isSs58(a.slice(0, -1) + (a.endsWith("1") ? "2" : "1"))).toBe(false);
    // Alice (well-known, prefix 42)
    expect(isSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")).toBe(true);
  });
});
