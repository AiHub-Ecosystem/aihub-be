import { getMetrics } from '@/common/observability/metrics';
import {
  type EmailSendRateRedisClient,
  RedisEmailSendRateLimiter,
} from './redis-email-send-rate-limiter';

class ScriptedRedis implements EmailSendRateRedisClient {
  constructor(
    private readonly answer: () => unknown,
    private readonly failure?: Error,
  ) {}

  async eval(): Promise<unknown> {
    if (this.failure !== undefined) throw this.failure;
    return this.answer();
  }

  on(): this {
    return this;
  }

  disconnect(): void {}
}

const MARKER = 'aihub_redis_unavailable_total{seam="email_send_rate"}';

/** The counter is shared by every spec in this process, so read a difference. */
async function unavailableCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(MARKER));
  return line === undefined ? 0 : Number(line.slice(MARKER.length + 1));
}

async function moves(action: () => Promise<unknown>): Promise<number> {
  const before = await unavailableCount();
  await action();
  return (await unavailableCount()) - before;
}

const down = () =>
  new RedisEmailSendRateLimiter(
    '',
    2,
    1_000,
    new ScriptedRedis(() => undefined, new Error('Command timed out')),
  );
const garbled = () =>
  new RedisEmailSendRateLimiter(
    '',
    2,
    1_000,
    new ScriptedRedis(() => 'not what the script returns'),
  );
const noRedis = () => new RedisEmailSendRateLimiter('', 2, 1_000);
const answering = (answer: unknown) =>
  new RedisEmailSendRateLimiter('', 2, 1_000, new ScriptedRedis(() => answer));

describe('email send-rate limiter counts every unavailable answer', () => {
  describe('reserve', () => {
    it.each([
      ['a command that fails or times out', down],
      ['a reply the script never returns', garbled],
      ['no Redis connection configured', noRedis],
    ])('counts %s', async (_name, limiter) => {
      await expect(moves(() => limiter().reserve())).resolves.toBe(1);
    });

    it('counts a missing rate configuration', async () => {
      const unconfigured = new RedisEmailSendRateLimiter(
        '',
        undefined,
        1_000,
        new ScriptedRedis(() => [1, 0]),
      );

      await expect(moves(() => unconfigured.reserve())).resolves.toBe(1);
    });

    it('does not count a reservation or a real wait for the next slot', async () => {
      await expect(moves(() => answering([1, 0]).reserve())).resolves.toBe(0);
      await expect(moves(() => answering([0, 125]).reserve())).resolves.toBe(0);
    });
  });

  describe('acquireSendPermit', () => {
    it.each([
      ['a command that fails or times out', down],
      ['a reply the script never returns', garbled],
      ['no Redis connection configured', noRedis],
    ])('counts %s', async (_name, limiter) => {
      await expect(moves(() => limiter().acquireSendPermit())).resolves.toBe(1);
    });

    it('does not count a permit or a real denial while the provider cools down', async () => {
      await expect(
        moves(() => answering([1, 0, 'probe']).acquireSendPermit()),
      ).resolves.toBe(0);
      await expect(
        moves(() => answering([0, 15_000, '']).acquireSendPermit()),
      ).resolves.toBe(0);
    });
  });

  describe('recordProviderFailure', () => {
    it.each([
      ['a command that fails or times out', down],
      ['a reply the script never returns', garbled],
      ['no Redis connection configured', noRedis],
    ])('counts %s', async (_name, limiter) => {
      await expect(
        moves(() => limiter().recordProviderFailure(1_000)),
      ).resolves.toBe(1);
    });

    it('does not count a failure Redis recorded', async () => {
      await expect(
        moves(() => answering(60_000).recordProviderFailure(30_000)),
      ).resolves.toBe(0);
    });
  });
});
