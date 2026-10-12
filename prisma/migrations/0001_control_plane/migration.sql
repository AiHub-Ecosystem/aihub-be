CREATE TABLE IF NOT EXISTS organizations (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended')),
  entitlements          text[] NOT NULL DEFAULT '{}',
  rate_limit_rpm        integer NOT NULL DEFAULT 600
                        CHECK (rate_limit_rpm > 0),
  max_concurrent        integer NOT NULL DEFAULT 20
                        CHECK (max_concurrent > 0),
  monthly_request_quota integer
                        CHECK (monthly_request_quota IS NULL OR monthly_request_quota >= 0),
  hard_stop_on_quota    boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                   text PRIMARY KEY,
  organization_id      text NOT NULL REFERENCES organizations(id),
  key_hash             bytea NOT NULL
                       CHECK (octet_length(key_hash) = 32),
  key_prefix           text NOT NULL,
  name                 text NOT NULL,
  scopes               text[] NOT NULL DEFAULT '{}',
  allowed_environments text[] NOT NULL DEFAULT '{production}',
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked')),
  expires_at           timestamptz,
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (organization_id);
