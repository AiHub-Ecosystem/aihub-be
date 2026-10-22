/** One error in the chain Prisma and its driver adapter nest a failure in. */
export interface PostgresErrorLink {
  readonly code: unknown;
  readonly message: unknown;
  readonly kind: unknown;
  /** Reached from inside a Prisma or driver-adapter error. */
  readonly wrapped: boolean;
}

/**
 * The first error in the chain that `matches`, walking `cause`, `meta`, and
 * `driverAdapterError`. Prisma copies a driver error's fields to `original*`.
 */
export function findPostgresErrorLink(
  error: unknown,
  matches: (link: PostgresErrorLink) => boolean,
): PostgresErrorLink | undefined {
  const pending: { readonly value: unknown; readonly wrapped: boolean }[] = [
    { value: error, wrapped: false },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const candidate = next.value;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    const link: PostgresErrorLink = {
      code: record.code ?? record.originalCode,
      message: record.message ?? record.originalMessage,
      kind: record.kind,
      wrapped: next.wrapped,
    };
    if (matches(link)) return link;

    const name = candidate instanceof Error ? candidate.name : '';
    const wrapped =
      next.wrapped ||
      name.startsWith('PrismaClient') ||
      name === 'DriverAdapterError';
    for (const key of ['cause', 'meta', 'driverAdapterError']) {
      if (record[key] !== undefined) {
        pending.push({
          value: record[key],
          wrapped: wrapped || key === 'driverAdapterError',
        });
      }
    }
  }

  return undefined;
}
