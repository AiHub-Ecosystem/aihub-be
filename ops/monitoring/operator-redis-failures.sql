-- Apply as the database owner in the shared control-plane database after 0051.
-- The monitoring login can read only these fixed aggregate rows, not identity data.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'aihub' THEN
    RAISE EXCEPTION 'operator Redis failure metrics are restricted to the shared control-plane database';
  END IF;
END;
$guard$;

GRANT USAGE ON SCHEMA public TO aihub_monitoring;
GRANT SELECT ON TABLE public.operator_redis_failures TO aihub_monitoring;
COMMIT;
