-- 0006 pinned the argon2 parameters as `m=,t=,p=`. The installed argon2 emits
-- them as `m=,p=,t=`, so every hash the application produced was rejected. The
-- work factor is still enforced; only the order it is written in is not.
ALTER TABLE auth_identities
  DROP CONSTRAINT auth_identities_password_hash_check;

ALTER TABLE auth_identities
  ADD CONSTRAINT auth_identities_password_hash_check CHECK (
    password_hash ~ '^\$argon2id\$v=19\$(m=65536,(t=3,p=1|p=1,t=3)|t=3,(m=65536,p=1|p=1,m=65536)|p=1,(m=65536,t=3|t=3,m=65536))\$'
  );