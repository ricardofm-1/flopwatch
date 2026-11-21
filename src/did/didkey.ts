import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";

/** Multicodec varint for ed25519-pub (0xed) → bytes 0xed 0x01. */
const ED25519_PUB_PREFIX = [0xed, 0x01] as const;
const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export class DidError extends Error {}

/** Parse an Ed25519 did:key (z6Mk…) to its 32-byte public key. Throws DidError. */
export function didKeyToPublicKey(did: string): Uint8Array {
  if (typeof did !== "string" || !DID_KEY_RE.test(did)) throw new DidError("not a base58btc did:key");
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(did.slice("did:key:z".length));
  } catch {
    throw new DidError("invalid base58btc");
  }
  if (bytes.length !== 34 || bytes[0] !== ED25519_PUB_PREFIX[0] || bytes[1] !== ED25519_PUB_PREFIX[1]) {
    throw new DidError("did:key is not Ed25519 (multicodec 0xed01)");
  }
  return bytes.slice(2);
}

export function publicKeyToDidKey(pub: Uint8Array): string {
  if (pub.length !== 32) throw new DidError("Ed25519 public key must be 32 bytes");
  const b = new Uint8Array(34);
  b.set(ED25519_PUB_PREFIX, 0);
  b.set(pub, 2);
  return `did:key:z${bs58.encode(b)}`;
}

export function isDidKey(did: unknown): did is string {
  if (typeof did !== "string") return false;
  try {
    didKeyToPublicKey(did);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify an Ed25519 signature. Uses native WebCrypto when available (cheap on the
 * 10 ms Free CPU budget) and falls back to @noble/curves.
 */
export async function verifyEd25519(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (sig.length !== 64 || pub.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, msg as BufferSource);
  } catch {
    try {
      return ed25519.verify(sig, msg, pub);
    } catch {
      return false;
    }
  }
}

export async function verifyDidSignature(did: string, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  let pub: Uint8Array;
  try {
    pub = didKeyToPublicKey(did);
  } catch {
    return false;
  }
  return verifyEd25519(pub, msg, sig);
}
