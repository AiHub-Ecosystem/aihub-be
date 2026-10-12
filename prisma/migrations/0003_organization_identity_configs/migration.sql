CREATE OR REPLACE FUNCTION is_public_identity_jwks(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  jwk jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR jsonb_typeof(value->'keys') <> 'array'
     OR jsonb_array_length(value->'keys') = 0 THEN
    RETURN false;
  END IF;

  FOR jwk IN
    SELECT element
    FROM jsonb_array_elements(value->'keys') AS elements(element)
  LOOP
    IF jsonb_typeof(jwk) <> 'object'
       OR jwk->>'kty' NOT IN ('RSA', 'EC')
       OR jwk ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']
       OR (jwk ? 'alg' AND jwk->>'alg' NOT IN ('RS256', 'ES256'))
       OR (jwk->>'alg' = 'RS256' AND jwk->>'kty' <> 'RSA')
       OR (jwk->>'alg' = 'ES256' AND jwk->>'kty' <> 'EC') THEN
      RETURN false;
    END IF;

    IF jwk->>'kty' = 'RSA'
       AND (coalesce(jwk->>'n', '') = '' OR coalesce(jwk->>'e', '') = '') THEN
      RETURN false;
    END IF;

    IF jwk->>'kty' = 'EC'
       AND (coalesce(jwk->>'crv', '') <> 'P-256'
            OR coalesce(jwk->>'x', '') = ''
            OR coalesce(jwk->>'y', '') = '') THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE TABLE IF NOT EXISTS organization_identity_configs (
  organization_id           text PRIMARY KEY REFERENCES organizations(id),
  issuer                    text NOT NULL
                            CHECK (length(issuer) BETWEEN 1 AND 2048
                                   AND issuer = btrim(issuer)),
  jwks_url                  text
                            CHECK (jwks_url IS NULL OR
                                   (jwks_url = btrim(jwks_url)
                                    AND left(lower(jwks_url), 8) = 'https://')),
  public_keys_jwks          jsonb
                            CHECK (public_keys_jwks IS NULL
                                   OR is_public_identity_jwks(public_keys_jwks)),
  allowed_algorithms        text[] NOT NULL DEFAULT ARRAY['RS256', 'ES256'],
  max_assertion_ttl_seconds integer NOT NULL DEFAULT 300
                            CHECK (max_assertion_ttl_seconds > 0
                                   AND max_assertion_ttl_seconds <= 3600),
  status                    text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (jwks_url IS NOT NULL OR public_keys_jwks IS NOT NULL),
  CHECK (cardinality(allowed_algorithms) > 0
         AND allowed_algorithms <@ ARRAY['RS256', 'ES256']::text[])
);

CREATE UNIQUE INDEX IF NOT EXISTS oic_issuer_uq
  ON organization_identity_configs (issuer);

DROP TRIGGER IF EXISTS organization_identity_configs_set_updated_at
  ON organization_identity_configs;

CREATE TRIGGER organization_identity_configs_set_updated_at
  BEFORE UPDATE ON organization_identity_configs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
