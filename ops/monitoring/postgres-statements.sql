-- Run once in each AIHUB database after the coordinated PostgreSQL restart.
BEGIN;

DO $guard$
BEGIN
  IF current_database() NOT IN ('aihub', 'aihub_sandbox') THEN
    RAISE EXCEPTION 'pg_stat_statements is restricted to AIHUB databases';
  END IF;
END;
$guard$;

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;
GRANT CONNECT ON DATABASE aihub_sandbox TO aihub_monitoring;

CREATE SCHEMA IF NOT EXISTS aihub_monitoring AUTHORIZATION aihub_admin;
REVOKE ALL ON SCHEMA aihub_monitoring FROM PUBLIC;
GRANT USAGE ON SCHEMA aihub_monitoring TO aihub_monitoring;

CREATE OR REPLACE FUNCTION aihub_monitoring.statement_stats()
RETURNS TABLE(
  queryid bigint,
  database_name text,
  calls bigint,
  total_exec_ms double precision,
  mean_exec_ms double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT stats.queryid,
         pg_catalog.current_database()::text,
         stats.calls,
         stats.total_exec_time,
         stats.mean_exec_time
  FROM public.pg_stat_statements AS stats
  WHERE stats.dbid = (
    SELECT db.oid
    FROM pg_catalog.pg_database AS db
    WHERE db.datname = pg_catalog.current_database()
  )
    AND stats.queryid IS NOT NULL
$function$;

ALTER FUNCTION aihub_monitoring.statement_stats() OWNER TO aihub_admin;
REVOKE ALL ON FUNCTION aihub_monitoring.statement_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aihub_monitoring.statement_stats() TO aihub_monitoring;

COMMIT;
