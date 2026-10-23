import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  type LocalAuthTestContext,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';

const HOUR = 60 * 60 * 1000;

describe('local auth HTTP boundary - email outbox backpressure', () => {
  let c: LocalAuthTestContext;
  beforeAll(async () => {
    c = await createLocalAuthTestContext();
  });
  afterAll(async () => {
    await c.app.close();
  });
  beforeEach(() => {
    c.reset();
  });

  function post(url: string, payload: Record<string, unknown>) {
    return c.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload,
    });
  }

  const register = {
    email: EMAIL,
    username: 'person_01',
    password: 'exact password',
  };

  it('refuses a registration with 503 and Retry-After when the backlog has used 18 hours of the 24-hour token', async () => {
    c.queueAge.ageMs = 18 * HOUR;

    const response = await post('/v1/auth/register', register);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'EMAIL_DELIVERY_BACKLOGGED',
        message: 'Email delivery is delayed; try again later',
        request_id: expect.stringMatching(/^req_/),
        retryable: true,
        retry_after_ms: 15 * 60 * 1000,
      },
    });
    expect(response.headers['retry-after']).toBe('900');
  });

  it('spends no rate limit and leaves no account, identity, token, or delivery request behind', async () => {
    c.queueAge.ageMs = 18 * HOUR;

    await post('/v1/auth/register', register);

    expect(c.limiter.calls).toEqual([]);
    expect(c.state.accounts.size).toBe(0);
    expect(c.state.verificationTokens.size).toBe(0);
    expect(c.state.emailDeliveryRequests).toEqual([]);
  });

  it('counts the refusal under the kind of the route', async () => {
    c.queueAge.ageMs = 18 * HOUR;

    await post('/v1/auth/register', register);
    await post('/v1/auth/resend-verification', { email: EMAIL });
    c.queueAge.ageMs = 45 * 60 * 1000;
    await post('/v1/auth/forgot-password', { email: EMAIL });

    expect(c.queueAge.refusals).toEqual([
      'verification_email',
      'verification_email',
      'password_reset_email',
    ]);
  });

  it('refuses password recovery with the same answer for a known and an unknown address', async () => {
    seedAccount(c.state, {
      userId: USER_ID,
      email: EMAIL,
      username: 'person_01',
      passwordHash: '$argon2id$fake',
    });
    c.queueAge.ageMs = 45 * 60 * 1000;

    const known = await post('/v1/auth/forgot-password', { email: EMAIL });
    const unknown = await post('/v1/auth/forgot-password', {
      email: 'nobody@example.com',
    });

    expect(known.statusCode).toBe(503);
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error.code).toBe(known.json().error.code);
    expect(c.limiter.calls).toEqual([]);
  });

  it('serves the request as before when the backlog is below the line', async () => {
    c.queueAge.ageMs = 18 * HOUR - 1;

    const response = await post('/v1/auth/register', register);

    expect(response.statusCode).toBe(201);
    expect(c.state.emailDeliveryRequests).toHaveLength(1);
    expect(c.queueAge.refusals).toEqual([]);
  });

  it('serves the request as before when the queue age cannot be read', async () => {
    c.queueAge.failure = new Error('database down');

    const response = await post('/v1/auth/register', register);

    expect(response.statusCode).toBe(201);
    expect(c.state.emailDeliveryRequests).toHaveLength(1);
  });
});
