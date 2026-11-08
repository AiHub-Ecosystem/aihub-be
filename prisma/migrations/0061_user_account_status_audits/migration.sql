CREATE TABLE user_account_status_audits (
  id text PRIMARY KEY
    CHECK (id ~ '^uasa_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  actor_user_account_id text NOT NULL
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  actor_source text NOT NULL DEFAULT 'legacy_unknown'
    CHECK (actor_source IN ('authenticated_user', 'self_declared_operator', 'legacy_unknown')),
  action text NOT NULL
    CHECK (action IN ('user_account.disabled', 'user_account.restored', 'refresh_session.revoked_all')),
  request_id text NOT NULL,
  occurred_at timestamptz(6) NOT NULL,
  CHECK (
    (action IN ('user_account.disabled', 'user_account.restored') AND user_account_id IS NOT NULL)
    OR
    (action = 'refresh_session.revoked_all' AND user_account_id IS NULL)
  )
);

CREATE INDEX user_account_status_audits_user_account_id_idx
  ON user_account_status_audits (user_account_id);

CREATE INDEX user_account_status_audits_actor_user_account_id_idx
  ON user_account_status_audits (actor_user_account_id);

CREATE INDEX user_account_status_audits_occurred_at_idx
  ON user_account_status_audits (occurred_at, id);

CREATE FUNCTION user_account_status_audits_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'user_account_status_audits is append-only';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_account_status_audits is append-only';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER user_account_status_audits_append_only
  BEFORE UPDATE OR DELETE ON user_account_status_audits
  FOR EACH ROW
  EXECUTE FUNCTION user_account_status_audits_append_only();
