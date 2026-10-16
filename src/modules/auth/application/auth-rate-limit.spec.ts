import { AppError } from '@/common/errors/app-error';
import { checkAuthRateLimits, enforceAuthRateLimits } from './auth-rate-limit';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';

type Limit = Parameters<AuthRateLimiterPort['consume']>[0];
type Decision = Awaited<ReturnType<AuthRateLimiterPort['consume']>>;

const IP_LIMIT: Limit = {
  scope: 'login_ip',
  key: '198.51.100.7',
  limit: 20,
  windowMs: 5 * 60_000,
};
const EMAIL_LIMIT: Limit = {
  scope: 'login_email',
  key: '["198.51.100.7","person@example.com"]',
  limit: 5,
  windowMs: 15 * 60_000,
};

class FakeLimiter implements AuthRateLimiterPort {
  readonly checked: string[] = [];
  readonly consumed: string[] = [];
  decisions = new Map<Limit['scope'], Decision>();

  async check(input: Limit): Promise<Decision> {
    this.checked.push(input.scope);
    return this.decisions.get(input.scope) ?? { allowed: true };
  }

  async consume(input: Limit): Promise<Decision> {
    this.consumed.push(input.scope);
    return this.decisions.get(input.scope) ?? { allowed: true };
  }
}

async function refusalOf(
  run: (limiter: AuthRateLimiterPort) => Promise<void>,
  decisions: Map<Limit['scope'], Decision>,
): Promise<AppError> {
  const limiter = new FakeLimiter();
  limiter.decisions = decisions;
  try {
    await run(limiter);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a rate-limited refusal');
}

/**
 * ADR-0096 promises one refusal for every authentication budget: `429
 * RATE_LIMITED`, retryable, a retry hint in the body and `Retry-After` on the
 * response. These tests exist so a route that builds its own refusal again, or
 * forgets the header flag, fails here rather than at an integrator.
 */
describe('authentication rate-limit refusals', () => {
  describe('the refusal itself', () => {
    it('answers with the public code, message and retryable flag', async () => {
      const refusal = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT]),
        new Map([['login_ip', { allowed: false, retryAfterMs: 60_000 }]]),
      );

      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal.code).toBe('RATE_LIMITED');
      expect(refusal.httpStatus).toBe(429);
      expect(refusal.message).toBe('Too many requests');
      expect(refusal.retryable).toBe(true);
    });

    it('asks for the Retry-After header, which is what makes the filter send it', async () => {
      const refusal = await refusalOf(
        (limiter) => checkAuthRateLimits(limiter, [EMAIL_LIMIT]),
        new Map([['login_email', { allowed: false, retryAfterMs: 900_000 }]]),
      );

      expect(refusal.retryAfterHeader).toBe(true);
      expect(refusal.retryAfterMs).toBe(900_000);
    });

    // A refusal with no wait to report is still rate limited; the filter emits
    // the header only when there is a number to send, so asking for one here
    // would publish a header the response cannot answer.
    it('asks for the header on a refusal that knows no wait too', async () => {
      const refusal = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT]),
        new Map([['login_ip', { allowed: false }]]),
      );

      expect(refusal.retryAfterHeader).toBe(true);
      expect(refusal.retryAfterMs).toBeUndefined();
    });
  });

  describe('several dimensions refusing the same request', () => {
    it('reports the longest wait standing, so a retry that obeys it can succeed', async () => {
      const refusal = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
        new Map([
          ['login_ip', { allowed: false, retryAfterMs: 60_000 }],
          ['login_email', { allowed: false, retryAfterMs: 15 * 60_000 }],
        ]),
      );

      expect(refusal.retryAfterMs).toBe(15 * 60_000);
    });

    it('reports the same wait whichever dimension is checked first', async () => {
      const decisions = new Map<Limit['scope'], Decision>([
        ['login_ip', { allowed: false, retryAfterMs: 60_000 }],
        ['login_email', { allowed: false, retryAfterMs: 15 * 60_000 }],
      ]);

      const ipFirst = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
        decisions,
      );
      const emailFirst = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [EMAIL_LIMIT, IP_LIMIT]),
        decisions,
      );

      expect(emailFirst.retryAfterMs).toBe(ipFirst.retryAfterMs);
    });

    it('reports the refused dimension when the other still admits', async () => {
      const refusal = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
        new Map([['login_ip', { allowed: false, retryAfterMs: 60_000 }]]),
      );

      expect(refusal.retryAfterMs).toBe(60_000);
    });

    it('skips a refused dimension that knows no wait rather than reading it as zero', async () => {
      const refusal = await refusalOf(
        (limiter) => enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
        new Map([
          ['login_ip', { allowed: false }],
          ['login_email', { allowed: false, retryAfterMs: 15 * 60_000 }],
        ]),
      );

      expect(refusal.retryAfterMs).toBe(15 * 60_000);
    });
  });

  describe('the two verbs', () => {
    it('checks every dimension before refusing and consumes none of them', async () => {
      const limiter = new FakeLimiter();
      limiter.decisions = new Map([
        ['login_ip', { allowed: false, retryAfterMs: 60_000 }],
      ]);

      await expect(
        checkAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

      expect(limiter.checked).toEqual(['login_ip', 'login_email']);
      expect(limiter.consumed).toEqual([]);
    });

    // The second dimension's budget is spent even when the first already
    // refuses. Not spending it would leave a second attempt with a full budget
    // on the very dimension the caller was just told to wait out.
    it('consumes every dimension before refusing', async () => {
      const limiter = new FakeLimiter();
      limiter.decisions = new Map([
        ['login_ip', { allowed: false, retryAfterMs: 60_000 }],
      ]);

      await expect(
        enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

      expect(limiter.consumed).toEqual(['login_ip', 'login_email']);
    });

    it('consumes every dimension when they all admit', async () => {
      const limiter = new FakeLimiter();

      await enforceAuthRateLimits(limiter, [IP_LIMIT, EMAIL_LIMIT]);

      expect(limiter.consumed).toEqual(['login_ip', 'login_email']);
    });

    it('accepts an empty dimension list', async () => {
      const limiter = new FakeLimiter();

      await expect(checkAuthRateLimits(limiter, [])).resolves.toBeUndefined();
      await expect(enforceAuthRateLimits(limiter, [])).resolves.toBeUndefined();
      expect(limiter.consumed).toEqual([]);
    });
  });
});
