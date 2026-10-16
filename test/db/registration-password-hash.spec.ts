import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { AppModule } from '@/app.module';
import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import { EMAIL_PAYLOAD_CIPHER } from '@/modules/auth/application/email-delivery-request.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '@/modules/auth/application/email-sender.port';
import { PASSWORD_HASHER } from '@/modules/auth/application/password-hasher.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/application/password-reset-token-repository.port';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/application/refresh-session-repository.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/application/verification-token-repository.port';
import { Argon2PasswordHasher } from '@/modules/auth/infrastructure/argon2-password.hasher';
import { createEmailPayloadCipher } from '@/modules/auth/infrastructure/email-payload-cipher';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from '@/modules/auth/infrastructure/postgres-auth.client';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/infrastructure/postgres-email-delivery-request.repository';
import { PostgresPasswordResetTokenRepository } from '@/modules/auth/infrastructure/postgres-password-reset-token.repository';
import { PostgresRefreshSessionRepository } from '@/modules/auth/infrastructure/postgres-refresh-session.repository';
import { PostgresUserAccountRepository } from '@/modules/auth/infrastructure/postgres-user-account.repository';
import { PostgresVerificationTokenRepository } from '@/modules/auth/infrastructure/postgres-verification-token.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const PASSWORD = 'correct horse battery staple';

class DiscardingSender implements EmailSenderPort {
  async sendVerificationEmail(): Promise<void> {}

  async sendPasswordResetEmail(): Promise<void> {}

  async sendOrganizationInviteEmail(): Promise<void> {}

  async sendMfaSecurityNotification(): Promise<void> {}
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
  const emailOutbox =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const emailRequests = new PostgresEmailDeliveryRequestRepository(emailOutbox);
  const accounts = new PostgresUserAccountRepository(authClient, emailRequests);
  const verification = new PostgresVerificationTokenRepository(
    authClient,
    emailRequests,
  );
  const resets = new PostgresPasswordResetTokenRepository(
    authClient,
    emailRequests,
  );
  const refresh = new PostgresRefreshSessionRepository(authClient);
  const cipher = createEmailPayloadCipher(emailOutbox);

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
    .overrideProvider(EMAIL_PAYLOAD_CIPHER)
    .useValue(cipher)
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
