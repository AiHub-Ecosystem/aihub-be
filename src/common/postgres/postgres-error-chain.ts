import { isRecord } from '@/common/is-record';

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
    if (!isRecord(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const link: PostgresErrorLink = {
      code: candidate['code'] ?? candidate['originalCode'],
      message: candidate['message'] ?? candidate['originalMessage'],
      kind: candidate['kind'],
      wrapped: next.wrapped,
    };
    if (matches(link)) return link;

    const name = candidate instanceof Error ? candidate.name : '';
    const wrapped =
      next.wrapped ||
      name.startsWith('PrismaClient') ||
      name === 'DriverAdapterError';
    for (const key of ['cause', 'meta', 'driverAdapterError']) {
      if (candidate[key] !== undefined) {
        pending.push({
          value: candidate[key],
          wrapped: wrapped || key === 'driverAdapterError',
        });
      }
    }
  }

  return undefined;
}
