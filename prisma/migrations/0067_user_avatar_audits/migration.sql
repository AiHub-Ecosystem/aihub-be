-- One row per accepted Avatar change (#429). An account sets, replaces, or
-- removes its own Avatar through its own session, so the account is both the
-- target and the actor; `actor_source` records how the actor was proven.
-- Nothing from the image itself is stored, and no URL: the asset id names the
-- object a reader can already address.
CREATE TABLE user_avatar_audits (
  id                    text PRIMARY KEY
    CHECK (id ~ '^uaa_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id       text NOT NULL
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  actor_source          text NOT NULL
    CHECK (actor_source IN ('authenticated_user')),
  action                text NOT NULL
    CHECK (action IN ('avatar.set', 'avatar.replaced', 'avatar.removed')),
  asset_id              text NOT NULL
    CHECK (asset_id ~ '^ava_[0-9A-HJKMNP-TV-Z]{26}$'),
  request_id            text NOT NULL,
  occurred_at           timestamptz(6) NOT NULL
);

-- "What happened to this account's Avatar, in order" is the one read this
-- table answers today.
-- squawk-ignore require-concurrent-index-creation -- in-transaction migration runner; approved: #429
CREATE INDEX user_avatar_audits_account_idx
  ON user_avatar_audits (user_account_id, occurred_at, id);

CREATE FUNCTION user_avatar_audits_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'user_avatar_audits is append-only';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_avatar_audits is append-only';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER user_avatar_audits_append_only
  BEFORE UPDATE OR DELETE ON user_avatar_audits
  FOR EACH ROW
  EXECUTE FUNCTION user_avatar_audits_append_only();
