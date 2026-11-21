import bs58 from "bs58";
import { blake2b } from "@noble/hashes/blake2.js";
import { utf8 } from "../lib/encoding";

const SS58_PREFIX = utf8.encode("SS58PRE");

function checksum(data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(SS58_PREFIX.length + data.length);
  buf.set(SS58_PREFIX, 0);
  buf.set(data, SS58_PREFIX.length);
  return blake2b(buf, { dkLen: 64 }).slice(0, 2);
}

/** Decode an SS58 address to its 32-byte account id; throws if malformed or checksum fails. */
export function ss58Decode(addr: string): { prefix: number; publicKey: Uint8Array } {
  if (typeof addr !== "string" || addr.length < 40 || addr.length > 50) throw new Error("bad ss58 length");
  const raw = bs58.decode(addr);
  const first = raw[0];
  if (first === undefined) throw new Error("empty");
  const prefixLen = first < 64 ? 1 : 2;
  if (raw.length !== prefixLen + 32 + 2) throw new Error("only 32-byte account ids supported");
  const body = raw.slice(0, prefixLen + 32);
  const cs = checksum(body);
  if (cs[0] !== raw[prefixLen + 32] || cs[1] !== raw[prefixLen + 33]) throw new Error("bad ss58 checksum");
  let prefix = first;
  if (prefixLen === 2) {
    const second = raw[1] ?? 0;
    prefix = ((first & 0x3f) << 2) | (second >> 6) | ((second & 0x3f) << 8);
  }
  return { prefix, publicKey: raw.slice(prefixLen, prefixLen + 32) };
}

export function isSs58(addr: unknown): addr is string {
  try {
    ss58Decode(addr as string);
    return true;
  } catch {
    return false;
  }
}

/** Encode (prefix < 64 only). Used by seeds and tests. */
export function ss58Encode(publicKey: Uint8Array, prefix = 42): string {
  if (prefix >= 64 || publicKey.length !== 32) throw new Error("unsupported");
  const body = new Uint8Array(33);
  body[0] = prefix;
  body.set(publicKey, 1);
  const cs = checksum(body);
  const out = new Uint8Array(35);
  out.set(body, 0);
  out.set(cs, 33);
  return bs58.encode(out);
}
