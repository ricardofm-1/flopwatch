-- One receipt per on-chain channel (32-byte hash ids). Channel-only receipts are now verifiable
-- (computeChannel.channels storage), so without this one real channel could be counted repeatedly.
CREATE UNIQUE INDEX uq_receipts_channel ON receipts(network, channel_id)
  WHERE channel_id IS NOT NULL AND length(channel_id) = 66 AND substr(channel_id, 1, 2) = '0x';
