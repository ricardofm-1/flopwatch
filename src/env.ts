export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  CACHE: KVNamespace;
  VERIFY_QUEUE: Queue<VerifyJob>;

  SESSION_SIGNING_KEY?: string;
  SITE_ORIGIN?: string;
  VERIFIER?: string;
  ALLOW_MOCK_VERIFIER?: string;
  FLOP_RPC_URL_DEVNET?: string;
  FLOP_RPC_URL_TESTNET?: string;
  EXPLORER_TX_URL_DEVNET?: string;
  EXPLORER_TX_URL_TESTNET?: string;
  EXPLORER_ACCOUNT_URL_DEVNET?: string;
  EXPLORER_ACCOUNT_URL_TESTNET?: string;
  CHALLENGE_TTL_SECONDS?: string;
  SESSION_TTL_SECONDS?: string;
  RATE_LIMIT_SUBMIT_HOURLY?: string;
  RATE_LIMIT_SUBMIT_DAILY?: string;
  RATE_LIMIT_CHALLENGE_HOURLY?: string;
  VERIFY_INLINE_TIMEOUT_MS?: string;
  VERIFY_MAX_ATTEMPTS?: string;
  FLOPSCAN_MARKETS_URL_DEVNET?: string;
  FLOPSCAN_MARKETS_URL_TESTNET?: string;
  FLOPSCAN_MINER_RELIABILITY_URL_DEVNET?: string;
  FLOPSCAN_MINER_RELIABILITY_URL_TESTNET?: string;
  REVIEW_MAX_PER_DID_DAILY?: string;
  REVIEW_MAX_PER_BUYER_7D?: string;
  REVIEW_FRESHNESS_DAYS?: string;
  REVIEW_MIN_N?: string;
  REVIEW_BAYES_M?: string;
  REVIEW_BAYES_PRIOR?: string;
  SHOW_SAMPLE_DATA?: string;
}

export interface VerifyJob {
  /** Optional only so a malformed/legacy message can be acked safely. */
  receiptId?: string;
}

export function intVar(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type Network = "testnet" | "devnet";
export const NETWORKS: readonly Network[] = ["testnet", "devnet"];

export function networkConfig(env: Env, network: Network) {
  const up = network.toUpperCase() as "TESTNET" | "DEVNET";
  return {
    rpcUrl: (env[`FLOP_RPC_URL_${up}`] ?? "").trim(),
    txUrl: (env[`EXPLORER_TX_URL_${up}`] ?? "").trim(),
    accountUrl: (env[`EXPLORER_ACCOUNT_URL_${up}`] ?? "").trim(),
    marketsUrl: (env[`FLOPSCAN_MARKETS_URL_${up}`] ?? "").trim(),
    minerReliabilityUrl: (env[`FLOPSCAN_MINER_RELIABILITY_URL_${up}`] ?? "").trim(),
  };
}

/** Explorer link from a configured template, or null. Never invents a URL. */
export function explorerLink(template: string, kind: "hash" | "address", value: string | null | undefined): string | null {
  if (!template || !value) return null;
  return template.replace(`{${kind}}`, encodeURIComponent(value));
}
