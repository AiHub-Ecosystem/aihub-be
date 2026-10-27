import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { AppModule } from '@/app.module';
import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { generateRequestId } from '@/common/request-context/request-id';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';
import { EmailOutbox } from '@/modules/auth/email-delivery/application/email-outbox';
import { EMAIL_OUTBOX } from '@/modules/auth/email-delivery/application/email-outbox.port';
import {
  EMAIL_SENDER,
  type EmailProviderResponse,
  type EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import { createEmailPayloadCipher } from '@/modules/auth/email-delivery/infrastructure/email-payload-cipher';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import { PASSWORD_HASHER } from '@/modules/auth/local-credentials/application/password-hasher.port';
import { Argon2PasswordHasher } from '@/modules/auth/local-credentials/infrastructure/argon2-password.hasher';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import { PostgresPasswordResetTokenRepository } from '@/modules/auth/password-reset/infrastructure/postgres-password-reset-token.repository';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/verification/application/verification-token-repository.port';
import { PostgresVerificationTokenRepository } from '@/modules/auth/verification/infrastructure/postgres-verification-token.repository';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';
import { PostgresRefreshSessionRepository } from '@/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './postgres-auth.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const PASSWORD = 'correct horse battery staple';

class DiscardingSender implements EmailSenderPort {
  async send(): Promise<EmailProviderResponse> {
    return { status: 202, retryAfter: undefined };
  }
}

class RateLimiterFake implements AuthRateLimiterPort {
  async check(): Promise<{ readonly allowed: true }> {
    return { allowed: true };
  }

  async consume(): Promise<{ readonly allowed: true }> {
    return { allowed: true };
  }
}

let pool: Pool;
let app: NestFastifyApplication;
let authClient: PostgresAuthClient;
let hasher: Argon2PasswordHasher;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl();
  pool = createTestPool();
  await resetIdentityTables(pool);

  hasher = new Argon2PasswordHasher();
  authClient = createPostgresAuthClient(testDatabaseUrl());
  const emailOutboxSecrets =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const emailRequests = new PostgresEmailDeliveryRequestRepository(
    emailOutboxSecrets,
  );
  const cipher = createEmailPayloadCipher(emailOutboxSecrets);
  const emailOutbox = new EmailOutbox(
    emailRequests,
    cipher,
    prefixedIdGenerator('edr_'),
    { admit: async () => undefined },
  );
  const accounts = new PostgresUserAccountRepository(authClient, emailOutbox);
  const verification = new PostgresVerificationTokenRepository(
    authClient,
    emailOutbox,
  );
  const resets = new PostgresPasswordResetTokenRepository(
    authClient,
    emailOutbox,
  );
  const refresh = new PostgresRefreshSessionRepository(authClient);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(accounts)
    .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
    .useValue(verification)
    .overrideProvider(PASSWORD_RESET_TOKEN_REPOSITORY)
    .useValue(resets)
    .overrideProvider(REFRESH_SESSION_REPOSITORY)
    .useValue(refresh)
    .overrideProvider(EMAIL_SENDER)
    .useValue(new DiscardingSender())
    .overrideProvider(EMAIL_OUTBOX)
    .useValue(emailOutbox)
    .overrideProvider(AUTH_RATE_LIMITER)
    .useValue(new RateLimiterFake())
    // The production binding, left in place on purpose: the stored hash is
    // whatever this library emits, so the constraint has to accept it.
    .overrideProvider(PASSWORD_HASHER)
    .useValue(hasher)
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
});

describe('registration against PostgreSQL', () => {
  it('stores the hash the real password hasher produces', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'person@example.com',
        username: 'person',
        password: PASSWORD,
      },
    });

    expect(response.statusCode).toBe(201);

    const stored = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM auth_identities WHERE canonical_email = $1',
      ['person@example.com'],
    );
    expect(stored.rows).toHaveLength(1);
    expect(
      await hasher.verify(PASSWORD, stored.rows[0]?.password_hash ?? ''),
    ).toBe(true);
  });
});
