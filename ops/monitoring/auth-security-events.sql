-- Apply as a database owner in the shared control-plane database.
-- Exposes only the durable count of successful account-disable audits.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'aihub' THEN
    RAISE EXCEPTION 'auth security event metrics are restricted to the shared control-plane database';
  END IF;
END;
$guard$;

CREATE SCHEMA IF NOT EXISTS aihub_monitoring;

CREATE OR REPLACE FUNCTION aihub_monitoring.auth_security_events()
RETURNS TABLE (event text, total bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT 'web_session_revoked'::text, count(*)::bigint
  FROM public.user_account_status_audits
  WHERE action = 'user_account.disabled'
$function$;

ALTER FUNCTION aihub_monitoring.auth_security_events() OWNER TO aihub_admin;
REVOKE ALL ON FUNCTION aihub_monitoring.auth_security_events() FROM PUBLIC;
GRANT USAGE ON SCHEMA aihub_monitoring TO aihub_monitoring;
GRANT EXECUTE ON FUNCTION aihub_monitoring.auth_security_events() TO aihub_monitoring;
COMMIT;
