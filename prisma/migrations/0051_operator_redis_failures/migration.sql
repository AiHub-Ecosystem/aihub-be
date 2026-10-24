-- One fixed row per Operator cache seam; no tenant, credential, or request data.
CREATE TABLE IF NOT EXISTS operator_redis_failures (
  seam text PRIMARY KEY,
  total bigint NOT NULL DEFAULT 0,
  CONSTRAINT operator_redis_failures_seam_check CHECK (seam IN (
    'api_key_cache',
    'api_key_cache_invalidation_revoke',
    'api_key_cache_invalidation_rotate',
    'api_key_cache_invalidation_suspension'
  )),
  CONSTRAINT operator_redis_failures_total_check CHECK (total >= 0)
);

INSERT INTO operator_redis_failures (seam) VALUES
  ('api_key_cache'),
  ('api_key_cache_invalidation_revoke'),
  ('api_key_cache_invalidation_rotate'),
  ('api_key_cache_invalidation_suspension')
ON CONFLICT (seam) DO NOTHING;
