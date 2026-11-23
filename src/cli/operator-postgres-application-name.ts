import type { PostgresConnectionRole } from '@/common/observability/metrics/metrics';

export function operatorPostgresApplicationName(
  role: PostgresConnectionRole,
): string {
  const configuredScope =
    process.env['AIHUB_RUNTIME_DATABASE_SCOPE']?.trim() || 'production';
  const scope =
    configuredScope === 'production' || configuredScope === 'sandbox'
      ? configuredScope
      : 'unknown';
  return 'aihub-be:' + scope + ':operator:' + role;
}
