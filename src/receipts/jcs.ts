import canonicalizeLib from "canonicalize";
import { utf8 } from "../lib/encoding";

const canonicalizeFn = canonicalizeLib as unknown as (v: unknown) => string | undefined;

/** RFC 8785 JSON Canonicalization Scheme → string. */
export function jcs(value: unknown): string {
  const out = canonicalizeFn(value);
  if (typeof out !== "string") throw new Error("value cannot be canonicalized");
  return out;
}

/** UTF-8 bytes of JCS(value): the exact bytes a DID signs. */
export function jcsBytes(value: unknown): Uint8Array {
  return utf8.encode(jcs(value));
}
