-- Avatar: at most one image per AIHUB User Account (ADR-0068). Durable
-- control-plane data; the bytes live in object storage and never here.
CREATE TABLE user_avatars (
  id              text PRIMARY KEY
                  CHECK (id ~ '^ava_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL
                  REFERENCES user_accounts(id) ON DELETE RESTRICT,
  object_key      text NOT NULL UNIQUE,
  content_type    text NOT NULL
                  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size       integer NOT NULL
                  CHECK (byte_size BETWEEN 1 AND 2097152),
  accepted_at     timestamptz NOT NULL,
  CONSTRAINT user_avatars_one_per_account UNIQUE (user_account_id),
  -- The owner is provable from the key alone, so the key must name the owner.
  CONSTRAINT user_avatars_key_names_owner CHECK (
    object_key = 'users/' || user_account_id || '/avatar/' || id || '/original'
  )
);
