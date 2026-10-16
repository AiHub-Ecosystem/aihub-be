-- Run as aihub_monitoring in aihub or aihub_sandbox. Never add query text here.
SELECT queryid,
       database_name,
       calls,
       round(total_exec_ms::numeric, 2) AS total_exec_ms,
       round(mean_exec_ms::numeric, 2) AS mean_exec_ms
FROM aihub_monitoring.statement_stats()
ORDER BY total_exec_ms DESC
LIMIT 20;

SELECT queryid,
       database_name,
       calls,
       round(total_exec_ms::numeric, 2) AS total_exec_ms,
       round(mean_exec_ms::numeric, 2) AS mean_exec_ms
FROM aihub_monitoring.statement_stats()
ORDER BY mean_exec_ms DESC
LIMIT 20;
