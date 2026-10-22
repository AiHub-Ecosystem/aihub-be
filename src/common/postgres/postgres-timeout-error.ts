import { findPostgresErrorLink } from './postgres-error-chain';

export type PostgresTimeout = 'statement_timeout' | 'lock_timeout';

const TIMEOUTS: Readonly<
  Record<string, { readonly kind: PostgresTimeout; readonly message: string }>
> = {
  '57014': {
    kind: 'statement_timeout',
    message: 'canceling statement due to statement timeout',
  },
  '55P03': {
    kind: 'lock_timeout',
    message: 'canceling statement due to lock timeout',
  },
};

export function postgresTimeoutKind(
  error: unknown,
): PostgresTimeout | undefined {
  const link = findPostgresErrorLink(error, ({ code, message }) => {
    const timeout = typeof code === 'string' ? TIMEOUTS[code] : undefined;
    return (
      timeout !== undefined &&
      typeof message === 'string' &&
      message.includes(timeout.message)
    );
  });
  return typeof link?.code === 'string' ? TIMEOUTS[link.code]?.kind : undefined;
}
