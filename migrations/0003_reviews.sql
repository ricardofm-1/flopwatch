-- Buyer reviews (FLOPWATCH-BUYER-REVIEWS-SPEC §11). Separate tables so receipt stats can't break.
CREATE TABLE reviews (
  id                   TEXT PRIMARY KEY,          -- sha256 hex of JCS(payload)
  network              TEXT NOT NULL,
  did                  TEXT NOT NULL,
  buyer                TEXT NOT NULL,
  miner                TEXT NOT NULL,
  model                TEXT NOT NULL,
  model_hash           TEXT,
  channel_id           TEXT NOT NULL,
  settlement_tx        TEXT,
  block_number         INTEGER,
  scores_json          TEXT NOT NULL,             -- { quality, latency, cost, delivery }
  delivered            INTEGER NOT NULL,
  prompt_category      TEXT,
  latency_ms           REAL,
  paid_flop            TEXT,
  max_flop             TEXT,
  paid_verified        INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  flopwatch_receipt_id TEXT,
  submitted_at         TEXT NOT NULL,
  nonce                TEXT NOT NULL UNIQUE,
  payload_json         TEXT NOT NULL,
  signature            TEXT NOT NULL,
  wallet_signature     TEXT,
  buyer_proof          TEXT,                      -- binding | wallet_signature | receipt
  r2_key               TEXT,
  received_at          INTEGER NOT NULL,
  verification         TEXT NOT NULL DEFAULT 'pending_verification',
  verification_note    TEXT,
  verify_attempts      INTEGER NOT NULL DEFAULT 0,
  verified_at          INTEGER,
  verified_by          TEXT,
  excluded_reason      TEXT,
  counted              INTEGER NOT NULL DEFAULT 0,
  is_sample            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reviews_miner ON reviews(network, miner, counted, submitted_at);
CREATE INDEX idx_reviews_did ON reviews(did, submitted_at);
CREATE INDEX idx_reviews_buyer ON reviews(buyer, counted, submitted_at);
CREATE INDEX idx_reviews_verification ON reviews(verification, received_at);
CREATE UNIQUE INDEX uq_reviews_channel ON reviews(network, channel_id)
  WHERE length(channel_id) = 66 AND substr(channel_id, 1, 2) = '0x';
CREATE UNIQUE INDEX uq_reviews_settlement ON reviews(network, settlement_tx)
  WHERE settlement_tx IS NOT NULL;

CREATE TABLE miner_review_stats (
  network                     TEXT NOT NULL,
  miner                       TEXT NOT NULL,
  model                       TEXT NOT NULL,
  window                      TEXT NOT NULL,       -- 7d | 30d | all
  n                           INTEGER NOT NULL,
  n_delivered                 INTEGER NOT NULL,
  delivery_rate               REAL,
  quality_avg                 REAL,
  latency_avg                 REAL,
  cost_avg                    REAL,
  delivery_avg                REAL,
  quality_median              REAL,
  buyer_score                 REAL,
  paid_flop_per_useful_median REAL,
  latency_p50                 REAL,
  latency_p95                 REAL,
  last_reviewed_at            TEXT,
  buyer_concentration         TEXT,                -- 'high' when one buyer > 30% and n >= 10
  computed_at                 INTEGER NOT NULL,
  PRIMARY KEY (network, miner, model, window)
);
