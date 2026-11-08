-- Bounded Avatar upload URL issuance (#374). One row per presigned URL, so the
-- number an account holds open at once and the number it is issued per rolling
-- window are counted facts rather than estimates.
CREATE TABLE user_avatar_upload_grants (
  id text PRIMARY KEY
    CHECK (id ~ '^ava_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL
    REFERENCES user_accounts(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  object_key text NOT NULL UNIQUE
    CHECK (object_key ~ '^users/usr_[0-9A-HJKMNP-TV-Z]{26}/avatar/ava_[0-9A-HJKMNP-TV-Z]{26}/original$'),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'consumed')),
  created_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  CHECK (expires_at > created_at)
);

-- The issuance window counts every grant in the window, consumed or not, so a
-- completion never restores issuance headroom.
-- The grant table is created empty in this migration, so a plain index build
-- takes no write lock worth avoiding.
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX user_avatar_upload_grants_issuance_idx
  ON user_avatar_upload_grants (user_account_id, created_at);

-- The open-URL ceiling counts unexpired grants; the sweep and the ceiling both
-- read this order.
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX user_avatar_upload_grants_expiry_idx
  ON user_avatar_upload_grants (expires_at);

-- The Organization ceilings count Speaking Audio intents and stored bytes per
-- Organization (#374); neither table had an organization-leading index.
-- Plain builds: the migration runner wraps each migration in a transaction, so
-- CONCURRENTLY is unavailable and the shared host does not take writes during a
-- deploy window; the tables are small per tenant. Approved: #374.
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX speaking_audio_upload_intents_org_idx
  ON speaking_audio_upload_intents (organization_id, created_at);

-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX speaking_audio_upload_intents_org_open_idx
  ON speaking_audio_upload_intents (organization_id, expires_at)
  WHERE status = 'open';

-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #374
CREATE INDEX speaking_audio_assets_org_idx
  ON speaking_audio_assets (organization_id);
