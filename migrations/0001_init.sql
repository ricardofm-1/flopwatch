-- Flopwatch — initial schema (SPEC.md §6.2)

CREATE TABLE challenges (
  nonce          TEXT PRIMARY KEY,           -- 128-bit hex
  challenge_json TEXT NOT NULL,              -- JCS of the challenge object as issued
  ip             TEXT,
  created_at     INTEGER NOT NULL,           -- unix ms
  expires_at     INTEGER NOT NULL,           -- unix ms
  used_at        INTEGER
);
CREATE INDEX idx_challenges_expires ON challenges(expires_at);

CREATE TABLE sessions_revoked (
  jti        TEXT PRIMARY KEY,
  did        TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE bindings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  did              TEXT NOT NULL,
  wallet           TEXT NOT NULL,
  network          TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  wallet_signature TEXT NOT NULL,            -- sr25519, hex
  did_signature    TEXT NOT NULL,            -- Ed25519, base64url
  created_at       INTEGER NOT NULL,
  UNIQUE (did, wallet, network)
);
CREATE INDEX idx_bindings_wallet ON bindings(wallet);

CREATE TABLE receipts (
  id                TEXT PRIMARY KEY,        -- sha256 hex of JCS(payload)
  network           TEXT NOT NULL,
  did               TEXT NOT NULL,
  buyer             TEXT NOT NULL,
  miner             TEXT NOT NULL,
  model             TEXT NOT NULL,
  model_hash        TEXT,
  channel_id        TEXT,
  settlement_tx     TEXT,
  block_number      INTEGER,
  status            TEXT NOT NULL,
  ok                INTEGER NOT NULL,
  max_flop          TEXT NOT NULL,
  paid_flop         TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        REAL,
  error_class       TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  submitted_at      TEXT NOT NULL,
  nonce             TEXT NOT NULL UNIQUE,
  payload_json      TEXT NOT NULL,           -- exact JCS bytes that were signed
  signature         TEXT NOT NULL,
  r2_key            TEXT,
  received_at       INTEGER NOT NULL,
  verification      TEXT NOT NULL DEFAULT 'pending_verification', -- pending_verification | passed | failed
  verification_note TEXT,
  verify_attempts   INTEGER NOT NULL DEFAULT 0,
  verified_at       INTEGER,
  verified_by       TEXT,                    -- verifier name; 'mock' rows never make the board LIVE
  excluded_reason   TEXT,                    -- e.g. self_dealing
  counted           INTEGER NOT NULL DEFAULT 0,
  is_sample         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_receipts_did ON receipts(did);
CREATE INDEX idx_receipts_miner ON receipts(miner, started_at);
CREATE INDEX idx_receipts_channel ON receipts(channel_id);
CREATE INDEX idx_receipts_status ON receipts(status);
CREATE INDEX idx_receipts_verification ON receipts(verification, received_at);
CREATE INDEX idx_receipts_group ON receipts(network, miner, model, counted);
CREATE INDEX idx_receipts_live ON receipts(network, counted, is_sample, verified_by);
-- Dedup / replay (SPEC §4): one settlement extrinsic counts once per network.
CREATE UNIQUE INDEX uq_receipts_settlement ON receipts(network, settlement_tx) WHERE settlement_tx IS NOT NULL;

CREATE TABLE miner_stats (
  network                TEXT NOT NULL,
  miner                  TEXT NOT NULL,
  model                  TEXT NOT NULL,
  window                 TEXT NOT NULL,      -- 7d | 30d | all
  is_sample              INTEGER NOT NULL DEFAULT 0,
  n                      INTEGER NOT NULL,
  success_rate           REAL,
  settlement_rate        REAL,
  latency_p50            REAL,
  latency_p95            REAL,
  price_session_median   REAL,
  price_token_median     REAL,
  last_seen              TEXT,
  computed_at            INTEGER NOT NULL,
  PRIMARY KEY (network, miner, model, window)
);

CREATE TABLE rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
