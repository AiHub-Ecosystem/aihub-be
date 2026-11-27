CREATE TABLE speaking_audio_publication_protocol (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  activated_at  timestamptz
);

INSERT INTO speaking_audio_publication_protocol (id, activated_at)
VALUES (true, NULL);

ALTER TABLE speaking_audio_upload_intents
  ADD COLUMN cleanup_claim_id text,
  ADD COLUMN cleanup_claim_expires_at timestamptz,
  ADD CONSTRAINT speaking_audio_upload_intents_cleanup_claim_check
    CHECK ((cleanup_claim_id IS NULL) = (cleanup_claim_expires_at IS NULL))
    NOT VALID;

CREATE TABLE speaking_audio_publication_reservations (
  id                       text PRIMARY KEY
                           CHECK (id ~ '^pub_[0-9a-f-]{36}$'),
  asset_id                 text NOT NULL
                           CHECK (asset_id ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id          text NOT NULL,
  end_user_id              text NOT NULL,
  environment              text NOT NULL
                           CHECK (environment IN ('production', 'sandbox')),
  object_key               text NOT NULL UNIQUE,
  status                   text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'abandoned')),
  created_at               timestamptz NOT NULL,
  expires_at               timestamptz NOT NULL,
  cleanup_claim_id         text,
  cleanup_claim_expires_at timestamptz,
  last_cleaned_at          timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((cleanup_claim_id IS NULL) = (cleanup_claim_expires_at IS NULL)),
  CHECK (
    object_key = 'orgs/' || organization_id || '/speaking/' || asset_id
      || '/publication/' || id
  )
);

CREATE INDEX speaking_audio_publication_reservations_expiry_idx
  ON speaking_audio_publication_reservations (expires_at, created_at)
  WHERE status IN ('active', 'abandoned');

CREATE INDEX speaking_audio_publication_reservations_active_asset_idx
  ON speaking_audio_publication_reservations (asset_id)
  WHERE status = 'active';

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'speaking_audio_assets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%object_key%'
  LOOP
    EXECUTE format(
      'ALTER TABLE speaking_audio_assets DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE speaking_audio_assets
  ADD CONSTRAINT speaking_audio_assets_object_key_check
  CHECK (
    object_key = 'orgs/' || organization_id || '/speaking/' || id || '/original'
    OR object_key ~ (
      '^orgs/' || organization_id || '/speaking/' || id
      || '/publication/pub_[0-9a-f-]{36}$'
    )
  ) NOT VALID;
