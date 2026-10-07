-- The Customer Web login session AIHUB owns (a Web Session, not a Refresh
-- Session: opaque, non-rotating, no token family). AIHUB stores only the
-- SHA-256 hash of the token, so a database leak reveals no usable session.
--
-- ponytail: expired and revoked rows are never purged. Add a cron job when the
-- table grows past the point where an unbounded table is worth indexing.
CREATE TABLE web_sessions (
  id              text PRIMARY KEY CHECK (id ~ '^wbs_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  last_renewed_at timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX web_sessions_user_account_id
  ON web_sessions (user_account_id);