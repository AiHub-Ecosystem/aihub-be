import { RedisEmailSendRateLimiter } from './redis-email-send-rate-limiter';

const mockConstructed: unknown[][] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    constructor(...args: unknown[]) {
      mockConstructed.push(args);
    }

    on(): this {
      return this;
    }

    disconnect(): void {}
  },
}));

describe('RedisEmailSendRateLimiter Redis client', () => {
  // Measured 2026-10-23: the Production app reaches the shared Redis host in
  // about 100 ms. A 100 ms command timeout failed every permit and reservation,
  // so no email was dispatched. docs/operations/redis-round-trip.md sets the
  // margin: at least three times the p95 round trip, rounded up to 100 ms.
  it('lets a command outlast the round trip to the shared Redis host', () => {
    expect(
      new RedisEmailSendRateLimiter(
        'redis://limiter:secret@redis.test.invalid/2',
        2,
        1_000,
      ),
    ).toBeInstanceOf(RedisEmailSendRateLimiter);

    const options = mockConstructed[0]?.[1] as { commandTimeout: number };
    expect(options.commandTimeout).toBeGreaterThanOrEqual(400);
  });
});
