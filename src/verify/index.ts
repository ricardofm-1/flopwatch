import type { Env } from "../env";
import { networkConfig } from "../env";
import type { ChainVerifier } from "./types";
import { MockVerifier } from "./mock";
import { RpcVerifier } from "./rpc";

export class VerifierConfigError extends Error {}

export function getVerifier(env: Env): ChainVerifier {
  const kind = (env.VERIFIER ?? "rpc").trim();
  if (kind === "mock") {
    if (env.ALLOW_MOCK_VERIFIER !== "true") {
      throw new VerifierConfigError("mock verifier refused: ALLOW_MOCK_VERIFIER is not 'true'");
    }
    return new MockVerifier();
  }
  if (kind === "rpc") {
    return new RpcVerifier({
      devnet: networkConfig(env, "devnet").rpcUrl || undefined,
      testnet: networkConfig(env, "testnet").rpcUrl || undefined,
    });
  }
  throw new VerifierConfigError(`unknown VERIFIER '${kind}'`);
}

export type { ChainVerifier, VerifyOutcome } from "./types";
