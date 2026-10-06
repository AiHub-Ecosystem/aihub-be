-- PostgreSQL does not index the referencing column of a foreign key. These two
-- point at user_accounts and had no index of their own, so changing or deleting
-- a User Account scanned the whole child table, and so would any lookup of "what
-- did this account do" by these columns. Both tables are tiny today; the point
-- is that they stay cheap once they are not.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: the migration runner applies each
-- file in one transaction, which CONCURRENTLY cannot run in, and the tables hold
-- almost no rows, so the brief lock is not a cost.
CREATE INDEX IF NOT EXISTS organization_audit_events_actor_idx
  ON organization_audit_events (actor_user_account_id);

CREATE INDEX IF NOT EXISTS organization_invitations_invited_by_idx
  ON organization_invitations (invited_by);
