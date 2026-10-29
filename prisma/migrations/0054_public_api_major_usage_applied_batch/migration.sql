-- The last write a process committed, so a write retried after its commit
-- response was lost adds its counts only once (#1389). Each process numbers
-- its writes from 1; the release being replaced keeps 0 and writes as before.
ALTER TABLE public_api_major_usage_coverage
  ADD COLUMN IF NOT EXISTS applied_batch bigint NOT NULL DEFAULT 0;
