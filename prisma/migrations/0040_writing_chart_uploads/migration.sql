CREATE TABLE writing_chart_uploads (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  end_user_id text NOT NULL,
  environment text NOT NULL,
  staging_key text NOT NULL UNIQUE,
  published_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  image_url text,
  created_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  published_at timestamptz(6),
  retention_expires_at timestamptz(6),
  CONSTRAINT writing_chart_uploads_environment_check
    CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT writing_chart_uploads_content_type_check
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT writing_chart_uploads_byte_size_check
    CHECK (byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT writing_chart_uploads_status_check
    CHECK (status IN ('open', 'rejected', 'publishing', 'published')),
  CONSTRAINT writing_chart_uploads_publication_check
    CHECK (
      (status = 'published' AND image_url IS NOT NULL AND published_at IS NOT NULL AND retention_expires_at IS NOT NULL)
      OR (status <> 'published' AND image_url IS NULL AND published_at IS NULL AND retention_expires_at IS NULL)
    )
);

CREATE INDEX writing_chart_uploads_org_created_idx
  ON writing_chart_uploads (organization_id, environment, created_at);
CREATE INDEX writing_chart_uploads_org_published_idx
  ON writing_chart_uploads (organization_id, environment, published_at)
  WHERE status = 'published';
CREATE INDEX writing_chart_uploads_intent_expiry_idx
  ON writing_chart_uploads (expires_at, created_at)
  WHERE status IN ('open', 'rejected', 'publishing');
CREATE INDEX writing_chart_uploads_retention_idx
  ON writing_chart_uploads (retention_expires_at, created_at)
  WHERE status = 'published';
