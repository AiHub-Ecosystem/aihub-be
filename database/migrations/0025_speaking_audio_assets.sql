CREATE TABLE speaking_audio_upload_intents (
  id                      text PRIMARY KEY
                          CHECK (id ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id         text NOT NULL
                          REFERENCES organizations(id) ON DELETE RESTRICT,
  end_user_id             text NOT NULL,
  environment             text NOT NULL
                          CHECK (environment IN ('production', 'sandbox')),
  object_key              text NOT NULL UNIQUE,
  content_type            text NOT NULL
                          CHECK (content_type IN (
                            'audio/wav', 'audio/mpeg', 'audio/mp4',
                            'audio/webm', 'audio/ogg'
                          )),
  byte_size               integer NOT NULL
                          CHECK (byte_size BETWEEN 100 AND 26214400),
  status                  text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'rejected')),
  created_at              timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (object_key = 'orgs/' || organization_id || '/speaking/' || id || '/original')
);

CREATE INDEX speaking_audio_upload_intents_expiry_idx
  ON speaking_audio_upload_intents (expires_at, created_at)
  WHERE status = 'open';

CREATE INDEX speaking_audio_upload_intents_rejected_idx
  ON speaking_audio_upload_intents (created_at)
  WHERE status = 'rejected';

CREATE TABLE speaking_audio_assets (
  id                      text PRIMARY KEY
                          CHECK (id ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id         text NOT NULL
                          REFERENCES organizations(id) ON DELETE RESTRICT,
  end_user_id             text NOT NULL,
  environment             text NOT NULL
                          CHECK (environment IN ('production', 'sandbox')),
  object_key              text NOT NULL UNIQUE,
  content_type            text NOT NULL
                          CHECK (content_type IN (
                            'audio/wav', 'audio/mpeg', 'audio/mp4',
                            'audio/webm', 'audio/ogg'
                          )),
  byte_size               integer NOT NULL
                          CHECK (byte_size BETWEEN 100 AND 26214400),
  accepted_at             timestamptz NOT NULL,
  retention_expires_at    timestamptz NOT NULL,
  CHECK (retention_expires_at > accepted_at),
  CHECK (object_key = 'orgs/' || organization_id || '/speaking/' || id || '/original')
);

CREATE INDEX speaking_audio_assets_retention_idx
  ON speaking_audio_assets (retention_expires_at, id);
