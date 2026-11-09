-- API key handling attribution (ADR-0151, #447).
--
-- A key's only attribution used to be the actor on `api_key.created` and
-- `api_key.rotated` audit events, and those are pruned after 24 months while an
-- unexpiring key lives forever. The two nullable account references record who
-- created the key and who last rotated it, so a disabled or demoted manager's
-- credentials stay attributable for as long as the keys do.
--
-- Deriving them from the audit trail instead was rejected: it cannot outlive the
-- retention window that makes it unreliable in exactly the case this fixes.
--
-- `last_rotated_by` is NULL for a key nobody rotated, which is not the same as a
-- name: the key list reports it as absent rather than guessing the creator.
--
-- Existing keys are not backfilled. The audit trail still answers for keys
-- created before this migration while it retains them, and NULL reads as
-- "unknown" rather than as a wrong account.

-- Both columns are nullable, so the scans see only rows this migration is
-- about to leave empty; the runner's transaction keeps writes out meanwhile.
-- squawk-ignore adding-foreign-key-constraint -- nullable column on a small table, runner holds the write lock
ALTER TABLE api_keys
  ADD COLUMN created_by text
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION; -- squawk-ignore adding-foreign-key-constraint -- nullable column on a small table, runner holds the write lock

ALTER TABLE api_keys
  ADD COLUMN last_rotated_by text
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION; -- squawk-ignore adding-foreign-key-constraint -- nullable column on a small table, runner holds the write lock

-- The runner runs migrations inside one transaction, so CONCURRENTLY is
-- unavailable here (same reasoning as 0062, approved: #374).
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX api_keys_created_by_idx ON api_keys (created_by);
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX api_keys_last_rotated_by_idx ON api_keys (last_rotated_by);
