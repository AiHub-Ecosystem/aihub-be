-- An operator revocation fences the upload from publishing again (#1206).
--
-- publication_started_at is when the current publication began, so the
-- revoke command can tell a publisher that may still be writing the public
-- object from one past its request deadline. The release being replaced
-- leaves it NULL.
ALTER TABLE writing_chart_uploads
  ADD COLUMN IF NOT EXISTS publication_started_at timestamptz(6);

-- Completion, refresh and lookup look for a requested revocation by asset.
CREATE INDEX IF NOT EXISTS writing_chart_revocation_audits_asset_id_idx -- squawk-ignore require-concurrent-index-creation -- the table holds one row per operator takedown; approved: #1206
  ON writing_chart_revocation_audits (asset_id);
