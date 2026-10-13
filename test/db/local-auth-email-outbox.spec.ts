import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppModule } from '@/app.module';
import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import {
  EMAIL_PAYLOAD_CIPHER,
  type EmailPayloadCipherPort,
} from '@/modules/auth/application/email-delivery-request.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '@/modules/auth/application/email-sender.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/application/password-hasher.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/application/password-reset-token-repository.port';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/application/refresh-session-repository.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/application/verification-token-repository.port';
import { createEmailPayloadCipher } from '@/modules/auth/infrastructure/email-payload-cipher';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from '@/modules/auth/infrastructure/postgres-auth.client';
import {
  PostgresEmailDeliveryRequestRepository,
  pruneExpiredAuthEmailRecipientLimits,
} from '@/modules/auth/infrastructure/postgres-email-delivery-request.repository';
import { PostgresLocalAuthRepository } from '@/modules/auth/infrastructure/postgres-local-auth.repository';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const REGISTER = '/v1/auth/register';
const RESEND = '/v1/auth/resend-verification';
const FORGOT = '/v1/auth/forgot-password';
const RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

/**
 * The real store, so a passing insert exercises the real table. Flipping this
 * is how the suite makes an outbox write fail and checks that the mutation it
 * serves is rolled back with it.
 */
class SwitchableEmailDeliveryRequests extends PostgresEmailDeliveryRequestRepository {
  failInserts = false;
  private secrets: EmailOutboxRuntimeSecrets;

  constructor(secrets: EmailOutboxRuntimeSecrets) {
    super(secrets);
    this.secrets = secrets;
  }

  get currentKeyId(): string {
    return this.secrets.currentKeyId;
  }

  rotateToNewKey(): void {
    const currentKeyId = `${this.secrets.currentKeyId}-next`;
    this.secrets = {
      currentKeyId,
      keys: {
        ...this.secrets.keys,
        [currentKeyId]: Buffer.alloc(32, 7).toString('base64'),
      },
    };
  }

  override reserveAuthenticationEmailRecipient(
    ...args: Parameters<
      PostgresEmailDeliveryRequestRepository['reserveAuthenticationEmailRecipient']
    >
  ): ReturnType<
    PostgresEmailDeliveryRequestRepository['reserveAuthenticationEmailRecipient']
  > {
    return new PostgresEmailDeliveryRequestRepository(
      this.secrets,
    ).reserveAuthenticationEmailRecipient(...args);
  }

  async insert(
    client: Parameters<PostgresEmailDeliveryRequestRepository['insert']>[0],
    input: Parameters<PostgresEmailDeliveryRequestRepository['insert']>[1],
  ): Promise<void> {
    if (this.failInserts) {
      throw new Error('email delivery request store is unavailable');
    }
    await super.insert(client, input);
  }
}

class RecordingSender implements EmailSenderPort {
  calls: string[] = [];

  async sendVerificationEmail(): Promise<void> {
    this.calls.push('sendVerificationEmail');
  }

  async sendPasswordResetEmail(): Promise<void> {
    this.calls.push('sendPasswordResetEmail');
  }

  async sendOrganizationInviteEmail(): Promise<void> {
    this.calls.push('sendOrganizationInviteEmail');
  }

  async sendMfaSecurityNotification(): Promise<void> {
    this.calls.push('sendMfaSecurityNotification');
  }
}

class RateLimiterFake implements AuthRateLimiterPort {
  async consume(): Promise<{ readonly allowed: true }> {
    return { allowed: true };
  }
}

/**
 * A fixed shape keeps this suite on the outbox pairing rather than on argon2's
 * cost. The `auth_identities` constraint accepts this order, and the real
 * hasher is exercised in registration-password-hash.spec.ts.
 */
const STORED_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA';

class PasswordHasherFake implements PasswordHasherPort {
  async hash(): Promise<string> {
    return STORED_PASSWORD_HASH;
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

interface SealedRequest {
  readonly kind: string;
  readonly status: string;
  readonly payload_ciphertext: string | null;
}

let pool: Pool;
let app: NestFastifyApplication;
let authClient: PostgresAuthClient;
let outbox: SwitchableEmailDeliveryRequests;
let sender: RecordingSender;
let cipher: EmailPayloadCipherPort;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl();
  pool = createTestPool();
  await resetIdentityTables(pool);

  sender = new RecordingSender();
  authClient = createPostgresAuthClient(testDatabaseUrl());
  const emailOutbox =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  outbox = new SwitchableEmailDeliveryRequests(emailOutbox);
  const repository = new PostgresLocalAuthRepository(authClient, outbox);
  cipher = createEmailPayloadCipher(emailOutbox);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(repository)
    .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
    .useValue(repository)
    .overrideProvider(PASSWORD_RESET_TOKEN_REPOSITORY)
    .useValue(repository)
    .overrideProvider(REFRESH_SESSION_REPOSITORY)
    .useValue(repository)
    .overrideProvider(EMAIL_SENDER)
    .useValue(sender)
    .overrideProvider(EMAIL_PAYLOAD_CIPHER)
    .useValue(cipher)
    .overrideProvider(AUTH_RATE_LIMITER)
    .useValue(new RateLimiterFake())
    .overrideProvider(PASSWORD_HASHER)
    .useValue(new PasswordHasherFake())
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => generateRequestId() }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await authClient?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  outbox.failInserts = false;
  sender.calls = [];
});

/** An account that already exists, in the state the route cares about. */
async function seedAccount(
  status: 'pending_verification' | 'active' | 'disabled',
  email: string,
): Promise<void> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`, status],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, now(), now())`,
    [`auth_${ulid()}`, id, email, STORED_PASSWORD_HASH],
  );
}

async function queuedRequests(): Promise<readonly SealedRequest[]> {
  const result = await pool.query<SealedRequest>(
    'SELECT kind, status, payload_ciphertext FROM email_delivery_requests ORDER BY created_at',
  );
  return result.rows;
}

async function countRows(table: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** What a worker would read back out of the row once it claims the request. */
function sealedPayload(row: SealedRequest | undefined): {
  readonly email: string;
  readonly token: string;
} {
  if (row?.payload_ciphertext === null || row === undefined) {
    throw new Error('the request carried no ciphertext');
  }
  return JSON.parse(cipher.decrypt(row.payload_ciphertext)) as {
    email: string;
    token: string;
  };
}

function registerRequest(email: string): {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  payload: Record<string, string>;
} {
  return {
    method: 'POST',
    url: REGISTER,
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      username: `user-${email.split('@')[0]}`,
      password: 'correct horse battery',
    },
  };
}

function post(url: string, email: string) {
  return {
    method: 'POST' as const,
    url,
    headers: { 'content-type': 'application/json' },
    payload: { email },
  };
}

describe('local auth email outbox over HTTP', () => {
  it('commits the account and its verification request together', async () => {
    const response = await app.inject(registerRequest('person@example.com'));

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        email: 'person@example.com',
        status: 'pending_verification',
        email_delivery_status: 'queued',
      },
    });
    expect(await countRows('user_accounts')).toBe(1);
    expect(await countRows('email_verification_tokens')).toBe(1);

    const requests = await queuedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'verification_email',
      status: 'queued',
    });
    // The payload is ciphertext on disk; only the keyring resolves it.
    expect(requests[0]?.payload_ciphertext).not.toContain('person@example.com');
    expect(sealedPayload(requests[0])).toMatchObject({
      email: 'person@example.com',
    });
    expect(sealedPayload(requests[0]).token).toEqual(expect.any(String));
    expect(sender.calls).toHaveLength(0);
  });

  it('supersedes the open verification token and queues the replacement', async () => {
    await seedAccount('pending_verification', 'person@example.com');

    const response = await app.inject(post(RESEND, ' Person@Example.com '));

    expect(response.statusCode).toBe(202);
    expect(response.payload).toBe('');
    const open = await pool.query(
      'SELECT count(*)::text AS count FROM email_verification_tokens WHERE consumed_at IS NULL',
    );
    expect(Number(open.rows[0]?.count)).toBe(1);
    const requests = await queuedRequests();
    expect(requests).toHaveLength(1);
    expect(sealedPayload(requests[0]).email).toBe('person@example.com');
    expect(sender.calls).toHaveLength(0);
  });

  it('answers the same for an address no account holds', async () => {
    const response = await app.inject(post(RESEND, 'nobody@example.com'));

    expect(response.statusCode).toBe(202);
    expect(response.payload).toBe('');
    expect(await queuedRequests()).toHaveLength(0);
    expect(await countRows('auth_email_recipient_rate_limits')).toBe(0);
  });

  it.each(['active', 'pending_verification', 'disabled'] as const)(
    'accepts a conditional recovery send for a %s account',
    async (status) => {
      await seedAccount(status, 'person@example.com');

      const response = await app.inject(post(FORGOT, ' Person@Example.com '));

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        data: { message: RECOVERY_MESSAGE },
      });
      expect(await queuedRequests()).toHaveLength(status === 'active' ? 1 : 0);
      expect(await countRows('auth_email_recipient_rate_limits')).toBe(
        status === 'active' ? 1 : 0,
      );
      expect(sender.calls).toHaveLength(0);
    },
  );

  it('seals the reset token into the recovery request it queues', async () => {
    await seedAccount('active', 'person@example.com');

    await app.inject(post(FORGOT, 'person@example.com'));

    expect(sealedPayload((await queuedRequests())[0])).toMatchObject({
      email: 'person@example.com',
    });
  });

  it('caps committed email requests across registration, resend, and recovery until the 24-hour window expires', async () => {
    const registration = await app.inject(
      registerRequest('person@example.com'),
    );
    expect(registration.statusCode).toBe(201);
    expect(registration.json().data.email_delivery_status).toBe('queued');

    for (let count = 0; count < 8; count += 1) {
      const response = await app.inject(post(RESEND, ' Person@Example.com '));
      expect(response.statusCode).toBe(202);
    }

    const firstWindow = await pool.query<{
      readonly address_hmac: string;
      readonly request_count: number;
      readonly window_started_at: Date;
      readonly expires_at: Date;
    }>(
      `SELECT address_hmac, request_count, window_started_at, expires_at
       FROM auth_email_recipient_rate_limits`,
    );
    expect(firstWindow.rows).toHaveLength(1);
    expect(firstWindow.rows[0]).toMatchObject({
      request_count: 9,
      window_started_at: expect.any(Date),
      expires_at: expect.any(Date),
    });
    expect(firstWindow.rows[0]?.address_hmac).not.toContain(
      'person@example.com',
    );

    const requestsBeforeResend = await queuedRequests();
    const cappedResend = await app.inject(post(RESEND, 'person@example.com'));
    expect(cappedResend.statusCode).toBe(202);
    expect(await queuedRequests()).toHaveLength(requestsBeforeResend.length);
    expect(await countRows('email_verification_tokens')).toBe(9);

    const latestToken = sealedPayload(requestsBeforeResend.at(-1)).token;
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: latestToken },
    });
    expect(verify.statusCode).toBe(204);

    const capped = await app.inject(post(FORGOT, 'person@example.com'));
    expect(capped.statusCode).toBe(202);
    expect(capped.json().data.message).toBe(RECOVERY_MESSAGE);
    expect(await queuedRequests()).toHaveLength(9);
    expect(await countRows('password_reset_tokens')).toBe(0);
    const unchangedWindow = await pool.query(
      `SELECT address_hmac, request_count, window_started_at, expires_at
       FROM auth_email_recipient_rate_limits`,
    );
    expect(unchangedWindow.rows).toEqual(firstWindow.rows);

    const account = await pool.query<{ readonly id: string }>(
      `SELECT user_account_id AS id FROM auth_identities
       WHERE provider = 'password' AND canonical_email = $1`,
      ['person@example.com'],
    );
    const accountId = account.rows[0]?.id;
    if (accountId === undefined) throw new Error('the account was not found');
    await pool.query(
      'DELETE FROM email_verification_tokens WHERE user_account_id = $1',
      [accountId],
    );
    await pool.query('DELETE FROM auth_identities WHERE user_account_id = $1', [
      accountId,
    ]);
    await pool.query('DELETE FROM user_accounts WHERE id = $1', [accountId]);

    const suppressedRegistration = await app.inject(
      registerRequest('person@example.com'),
    );
    expect(suppressedRegistration.statusCode).toBe(201);
    expect(suppressedRegistration.json().data).toMatchObject({
      status: 'pending_verification',
      email_delivery_status: 'suppressed',
    });
    expect(await countRows('email_delivery_requests')).toBe(9);

    await pool.query(
      `UPDATE auth_email_recipient_rate_limits
       SET window_started_at = now() - interval '24 hours' - interval '1 second',
           expires_at = now() - interval '1 second'`,
    );
    const afterExpiry = await app.inject(post(RESEND, 'person@example.com'));
    expect(afterExpiry.statusCode).toBe(202);
    expect(await queuedRequests()).toHaveLength(10);
  });

  it('cannot commit more than nine requests for one recipient under concurrent recovery calls', async () => {
    await seedAccount('active', 'person@example.com');

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject(post(FORGOT, 'person@example.com')),
      ),
    );

    expect(responses.every((response) => response.statusCode === 202)).toBe(
      true,
    );
    expect(await queuedRequests()).toHaveLength(9);
    const limits = await pool.query<{ readonly request_count: number }>(
      'SELECT request_count FROM auth_email_recipient_rate_limits',
    );
    expect(limits.rows[0]?.request_count).toBe(9);
  });

  it('keeps an active window across staged key rotation and uses the new key for fresh windows', async () => {
    const originalKeyId = outbox.currentKeyId;
    await app.inject(registerRequest('person@example.com'));
    outbox.rotateToNewKey();

    for (let count = 0; count < 8; count += 1) {
      await app.inject(post(RESEND, 'person@example.com'));
    }
    await seedAccount('active', 'new-person@example.com');
    await app.inject(post(FORGOT, 'new-person@example.com'));

    const limits = await pool.query<{
      readonly key_version: string;
      readonly request_count: number;
    }>(
      `SELECT key_version, request_count
       FROM auth_email_recipient_rate_limits
       ORDER BY key_version`,
    );
    expect(limits.rows).toEqual([
      { key_version: originalKeyId, request_count: 9 },
      { key_version: `${originalKeyId}-next`, request_count: 1 },
    ]);
  });

  it('deletes recipient counters after their fixed window expires', async () => {
    await seedAccount('active', 'person@example.com');
    await app.inject(post(FORGOT, 'person@example.com'));
    await pool.query(
      `UPDATE auth_email_recipient_rate_limits
       SET window_started_at = now() - interval '24 hours' - interval '1 second',
           expires_at = now() - interval '1 second'`,
    );

    await expect(
      pruneExpiredAuthEmailRecipientLimits(authClient, new Date()),
    ).resolves.toBe(1);
    expect(await countRows('auth_email_recipient_rate_limits')).toBe(0);
  });

  it('answers an unknown address exactly as it answers a known one', async () => {
    await seedAccount('active', 'person@example.com');
    const known = await app.inject(post(FORGOT, 'person@example.com'));
    const unknown = await app.inject(post(FORGOT, 'nobody@example.com'));

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json().data).toEqual(known.json().data);
  });

  it('rolls the account back when its outbox write fails', async () => {
    outbox.failInserts = true;

    const response = await app.inject(registerRequest('rollback@example.com'));

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.payload).not.toContain('email delivery request store');
    expect(await countRows('user_accounts')).toBe(0);
    expect(await countRows('email_verification_tokens')).toBe(0);
    expect(await countRows('email_delivery_requests')).toBe(0);
    expect(await countRows('auth_email_recipient_rate_limits')).toBe(0);
  });

  it('rolls the verification rotation back when its outbox write fails', async () => {
    await seedAccount('pending_verification', 'person@example.com');
    outbox.failInserts = true;

    const response = await app.inject(post(RESEND, 'person@example.com'));

    expect(response.statusCode).toBe(500);
    expect(await countRows('email_verification_tokens')).toBe(0);
    expect(await countRows('auth_email_recipient_rate_limits')).toBe(0);
  });

  it('rolls the reset token back when its outbox write fails', async () => {
    await seedAccount('active', 'person@example.com');
    outbox.failInserts = true;

    const response = await app.inject(post(FORGOT, 'person@example.com'));

    expect(response.statusCode).toBe(500);
    expect(await countRows('password_reset_tokens')).toBe(0);
    expect(await countRows('auth_email_recipient_rate_limits')).toBe(0);
  });
});
