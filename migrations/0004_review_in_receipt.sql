-- Reviews are now part of the receipt: one signed payload, one POST /v1/receipts, rating mandatory.
-- The standalone reviews table (0003) never held data in production (checked 2026-11-27) and is dropped.
ALTER TABLE receipts ADD COLUMN rating REAL;            -- 1–5 in 0.5 steps; NULL only on pre-0004 rows
ALTER TABLE receipts ADD COLUMN review_notes TEXT;      -- optional, ≤ 500 chars, trimmed
ALTER TABLE receipts ADD COLUMN review_excluded TEXT;   -- e.g. buyer_review_cap; receipt itself may still count
CREATE INDEX idx_receipts_rated ON receipts(network, miner, model, counted, submitted_at);
CREATE INDEX idx_receipts_buyer ON receipts(network, buyer, counted, submitted_at);

DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS miner_review_stats;
CREATE TABLE miner_review_stats (
  network                     TEXT NOT NULL,
  miner                       TEXT NOT NULL,
  model                       TEXT NOT NULL,
  window                      TEXT NOT NULL,       -- 7d | 30d | all
  n                           INTEGER NOT NULL,    -- counted ratings
  rating_avg                  REAL,                -- Bayesian-shrunk mean
  rating_median               REAL,
  n_delivered                 INTEGER NOT NULL,    -- receipts with ok = true
  delivery_rate               REAL,
  paid_flop_per_useful_median REAL,
  last_reviewed_at            TEXT,
  buyer_concentration         TEXT,                -- 'high' when one buyer > 30% and n >= 10
  is_sample                   INTEGER NOT NULL DEFAULT 0,
  computed_at                 INTEGER NOT NULL,
  PRIMARY KEY (network, miner, model, window)
);
