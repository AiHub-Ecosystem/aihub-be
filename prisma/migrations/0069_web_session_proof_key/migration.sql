-- A Web Session may bind its first DPoP proof-key thumbprint once. Existing
-- sessions remain unbound until exchange claims a key with a compare-and-set.
ALTER TABLE web_sessions
  ADD COLUMN proof_key_jkt text
  CONSTRAINT web_sessions_proof_key_jkt_format
  CHECK (proof_key_jkt IS NULL OR proof_key_jkt ~ '^[A-Za-z0-9_-]{43}$');
