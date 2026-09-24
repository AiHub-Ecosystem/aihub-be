-- Keep old in-flight JWKS fetches isolated from a newly saved configuration.
ALTER TABLE organization_identity_configs
  ADD COLUMN IF NOT EXISTS jwks_cache_version bigint NOT NULL DEFAULT 1
  CHECK (jwks_cache_version > 0);
