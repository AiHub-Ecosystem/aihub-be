CREATE TABLE IF NOT EXISTS idempotency_records (
  organization_id    text NOT NULL REFERENCES organizations(id),
  operation          text NOT NULL,
  idempotency_key    text NOT NULL
                     CHECK (length(idempotency_key) BETWEEN 1 AND 255
                            AND octet_length(idempotency_key) <= 255),
  request_fingerprint bytea NOT NULL
                     CHECK (octet_length(request_fingerprint) = 32),
  state              text NOT NULL
                     CHECK (state IN ('pending', 'completed', 'failed')),
  request_id         text NOT NULL,
  response_status    integer,
  response_body      jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  expires_at         timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation, idempotency_key),
  CHECK (
    (state = 'completed'
      AND response_status IS NOT NULL
      AND response_body IS NOT NULL
      AND completed_at IS NOT NULL)
    OR
    (state <> 'completed'
      AND response_status IS NULL
      AND response_body IS NULL
      AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idempotency_records_expires_idx
  ON idempotency_records (expires_at);
