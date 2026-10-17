export type PostgresTimeout = 'statement_timeout' | 'lock_timeout';

export function postgresTimeoutKind(
  error: unknown,
): PostgresTimeout | undefined {
  const pending = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    const code = record.code ?? record.originalCode;
    const message = record.message ?? record.originalMessage;
    if (
      code === '57014' &&
      typeof message === 'string' &&
      message.includes('canceling statement due to statement timeout')
    ) {
      return 'statement_timeout';
    }
    if (
      code === '55P03' &&
      typeof message === 'string' &&
      message.includes('canceling statement due to lock timeout')
    ) {
      return 'lock_timeout';
    }

    for (const key of ['cause', 'meta', 'driverAdapterError']) {
      if (record[key] !== undefined) pending.push(record[key]);
    }
  }

  return undefined;
}
