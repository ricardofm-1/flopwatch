import * as sr25519 from "@scure/sr25519";
import { hexToBytes, utf8 } from "../lib/encoding";
import { ss58Decode } from "./ss58";

/**
 * Verify an sr25519 wallet signature over a JCS string, accepting the raw bytes or the
 * polkadot-js signRaw wrapping (<Bytes>…</Bytes>). Never throws.
 */
export function verifyWalletSignature(jcsString: string, signatureHex: string, ss58: string): boolean {
  try {
    const pub = ss58Decode(ss58).publicKey;
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 64) return false;
    return sr25519.verify(utf8.encode(jcsString), sig, pub) || sr25519.verify(utf8.encode(`<Bytes>${jcsString}</Bytes>`), sig, pub);
  } catch {
    return false;
  }
}
