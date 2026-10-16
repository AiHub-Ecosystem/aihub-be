BEGIN;

CREATE ROLE aihub_monitoring LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE aihub TO aihub_monitoring;

CREATE SCHEMA aihub_monitoring AUTHORIZATION aihub_admin;
REVOKE ALL ON SCHEMA aihub_monitoring FROM PUBLIC;

CREATE FUNCTION aihub_monitoring.snapshot()
RETURNS TABLE(metric text, database_name text, value double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH activity AS (
    SELECT datname, wait_event_type, xact_start
    FROM pg_catalog.pg_stat_activity
    WHERE backend_type = 'client backend'
  ),
  cluster_metrics AS (
    SELECT 'connections_total'::text AS metric,
           ''::text AS database_name,
           count(*)::double precision AS value
    FROM activity
    UNION ALL
    SELECT 'max_connections', '',
           current_setting('max_connections')::double precision
    UNION ALL
    SELECT 'waiting_connections', '',
           count(*)::double precision
    FROM activity
    WHERE wait_event_type = 'Lock'
    UNION ALL
    SELECT 'waiting_locks', '',
           count(*)::double precision
    FROM pg_catalog.pg_locks
    WHERE NOT granted
  ),
  database_metrics AS (
    SELECT 'database_size_bytes'::text AS metric,
           datname::text AS database_name,
           pg_catalog.pg_database_size(datname)::double precision AS value
    FROM pg_catalog.pg_database
    WHERE datname IN ('aihub', 'aihub_sandbox')
    UNION ALL
    SELECT 'long_transactions_count', d.datname::text,
           count(a.xact_start)::double precision
    FROM pg_catalog.pg_database AS d
    LEFT JOIN activity AS a
      ON a.datname = d.datname
     AND a.xact_start < now() - interval '5 minutes'
    WHERE d.datname IN ('aihub', 'aihub_sandbox')
    GROUP BY d.datname
    UNION ALL
    SELECT 'longest_transaction_seconds', d.datname::text,
           coalesce(max(extract(epoch FROM now() - a.xact_start)), 0)::double precision
    FROM pg_catalog.pg_database AS d
    LEFT JOIN activity AS a
      ON a.datname = d.datname
     AND a.xact_start IS NOT NULL
    WHERE d.datname IN ('aihub', 'aihub_sandbox')
    GROUP BY d.datname
  )
  SELECT metric, database_name, value FROM cluster_metrics
  UNION ALL
  SELECT metric, database_name, value FROM database_metrics
$function$;

ALTER FUNCTION aihub_monitoring.snapshot() OWNER TO aihub_admin;
REVOKE ALL ON FUNCTION aihub_monitoring.snapshot() FROM PUBLIC;
GRANT USAGE ON SCHEMA aihub_monitoring TO aihub_monitoring;
GRANT EXECUTE ON FUNCTION aihub_monitoring.snapshot() TO aihub_monitoring;

COMMIT;
