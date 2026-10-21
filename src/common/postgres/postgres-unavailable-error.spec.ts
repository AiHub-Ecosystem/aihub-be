import { isPostgresUnavailable } from './postgres-unavailable-error';

function networkError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function prismaError(cause: unknown): Error {
  const error = new Error('Invalid prisma invocation');
  error.name = 'PrismaClientKnownRequestError';
  return Object.assign(error, {
    code: 'P2010',
    meta: { driverAdapterError: cause },
  });
}

describe('isPostgresUnavailable', () => {
  it.each([
    ['an unreachable database', { kind: 'DatabaseNotReachable' }],
    ['a closed connection', { kind: 'ConnectionClosed' }],
    ['a socket timeout', { kind: 'SocketTimeout' }],
    ['a Prisma pool timeout', { code: 'P2024' }],
    ['a server shutdown', { code: '57P01' }],
    ['a connection-exception SQLSTATE', { code: '08006' }],
  ])('recognizes %s', (_name, cause) => {
    expect(isPostgresUnavailable(prismaError(cause))).toBe(true);
  });

  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'Query read timeout',
    'Transaction API error: Unable to start a transaction in the given time.',
  ])('recognizes the connection message %s', (message) => {
    expect(isPostgresUnavailable(new Error(message))).toBe(true);
  });

  it('recognizes a socket error inside a Prisma error', () => {
    expect(
      isPostgresUnavailable(prismaError(networkError('ECONNREFUSED'))),
    ).toBe(true);
  });

  it('does not treat a bare socket error from another dependency as a database outage', () => {
    expect(isPostgresUnavailable(networkError('ECONNREFUSED'))).toBe(false);
  });

  it.each([
    [
      'a constraint violation',
      prismaError({ kind: 'postgres', code: '23505' }),
    ],
    ['a statement timeout', prismaError({ kind: 'postgres', code: '57014' })],
    ['a plain error', new Error('boom')],
    ['a non-error value', 'boom'],
  ])('rejects %s', (_name, error) => {
    expect(isPostgresUnavailable(error)).toBe(false);
  });

  it('stops on a cause cycle', () => {
    const error: Record<string, unknown> = { message: 'loop' };
    error.cause = error;
    expect(isPostgresUnavailable(error)).toBe(false);
  });
});
