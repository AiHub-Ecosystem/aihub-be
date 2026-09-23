ALTER TABLE email_verification_tokens
  ADD COLUMN consumed_reason text;

-- Previously consumed tokens for an active account end with the token that activated it.
WITH consumed_tokens AS (
  SELECT id,
         user_account_id,
         row_number() OVER (
           PARTITION BY user_account_id
           ORDER BY created_at DESC, id DESC
         ) AS recency
  FROM email_verification_tokens
  WHERE consumed_at IS NOT NULL
)
UPDATE email_verification_tokens token
SET consumed_reason = CASE
  WHEN account.status = 'active' AND consumed_tokens.recency = 1
    THEN 'verified'
  ELSE 'superseded'
END
FROM consumed_tokens
JOIN user_accounts account ON account.id = consumed_tokens.user_account_id
WHERE token.id = consumed_tokens.id;

ALTER TABLE email_verification_tokens
  ADD CONSTRAINT email_verification_consumption_reason_check
  CHECK (
    (consumed_at IS NULL AND consumed_reason IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND consumed_reason IS NOT NULL
      AND consumed_reason IN ('verified', 'superseded')
    )
  );
