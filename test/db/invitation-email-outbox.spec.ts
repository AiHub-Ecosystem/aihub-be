import { createHash } from 'node:crypto';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import type { EmailPayloadCipherPort } from '@/modules/auth/application/email-delivery-request.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '@/modules/auth/application/email-sender.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { createEmailPayloadCipher } from '@/modules/auth/infrastructure/email-payload-cipher';
import {
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from '@/modules/identity/application/organization-invitation.port';
import {
  type PostgresIdentityQueryClient,
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationInvitationRepository } from '@/modules/identity/infrastructure/postgres-organization-invitation.repository';
import { createRuntimeSecretProviderFromProcessEnvironment } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const ORGANIZATION_ID = 'org_acme';
const INVITE_URL = `/v1/organizations/${ORGANIZATION_ID}/invitations`;
const INVITEE = 'invitee@example.com';
const BEARER = 'Bearer valid.token.value';

/**
 * The real client, with one lever: failing the outbox insert is how the suite
 * checks that the invitation and its audit event are rolled back with it.
 */
class SwitchableIdentityClient implements PostgresIdentityTransactionalClient {
  failOutboxInserts = false;

  constructor(
    private readonly inner: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    },
  ) {}

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    return this.inner.query(text, values);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T> {
    return this.inner.transaction<T>((client) =>
      callback({
        query: async (text, values) => {
          if (
            this.failOutboxInserts &&
            text.includes('INSERT INTO email_delivery_requests')
          ) {
            throw new Error('email delivery request store is unavailable');
          }
          return client.query(text, values);
        },
      }),
    );
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
}

class CountingRateLimiter implements AuthRateLimiterPort {
  consumed = 0;

  async consume(): Promise<{ readonly allowed: true }> {
    this.consumed += 1;
    return { allowed: true };
  }
}

interface SealedRequest {
  readonly kind: string;
  readonly status: string;
  readonly payload_ciphertext: string | null;
}

let pool: Pool;
let app: NestFastifyApplication;
let identityClient: SwitchableIdentityClient;
let sender: RecordingSender;
let rateLimiter: CountingRateLimiter;
let cipher: EmailPayloadCipherPort;
const ownerId = `usr_${ulid()}`;

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabaseUrl();
  pool = createTestPool();

  sender = new RecordingSender();
  rateLimiter = new CountingRateLimiter();
  identityClient = new SwitchableIdentityClient(
    createPostgresIdentityClient(testDatabaseUrl()),
  );
  cipher = createEmailPayloadCipher(
    createRuntimeSecretProviderFromProcessEnvironment().getSnapshot()
      .emailOutbox,
  );

  const invitations: OrganizationInvitationPort =
    new PostgresOrganizationInvitationRepository(identityClient, cipher);
  const verifier: UserAccessTokenVerifierPort = {
    verify: async (token: string) => {
      if (token !== 'valid.token.value') {
        throw new Error('invalid token');
      }
      return { userId: ownerId, jti: 'jti_01' };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ORGANIZATION_INVITATION)
    .useValue(invitations)
    .overrideProvider(AUTH_RATE_LIMITER)
    .useValue(rateLimiter)
    .overrideProvider(EMAIL_SENDER)
    .useValue(sender)
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(verifier)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => generateRequestId() }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await identityClient?.close();
  await pool?.end();
});

/** An active owner of an active Organization: the only caller who may invite. */
async function seedOwner(): Promise<void> {
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [ownerId, `owner-${ownerId.slice(4, 16).toLowerCase()}`],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, now(), now())`,
    [
      `auth_${ulid()}`,
      ownerId,
      'owner@example.com',
      '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA',
    ],
  );
  await pool.query(
    `INSERT INTO organizations (id, name, status) VALUES ($1, 'Acme', 'active')`,
    [ORGANIZATION_ID],
  );
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, 'owner', 'active', now(), now())`,
    [ORGANIZATION_ID, ownerId],
  );
}

beforeEach(async () => {
  await resetIdentityTables(pool);
  await seedOwner();
  identityClient.failOutboxInserts = false;
  sender.calls = [];
  rateLimiter.consumed = 0;
});

function invite(headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: INVITE_URL,
    headers: { authorization: BEARER, ...headers },
    payload: { email: INVITEE, role: 'member' },
  });
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
  readonly organizationName: string;
  readonly role: string;
  readonly token: string;
  readonly expiresAt: string;
} {
  if (row?.payload_ciphertext === null || row === undefined) {
    throw new Error('the request carried no ciphertext');
  }
  return JSON.parse(cipher.decrypt(row.payload_ciphertext)) as {
    email: string;
    organizationName: string;
    role: string;
    token: string;
    expiresAt: string;
  };
}

describe('organization invitation email outbox over HTTP', () => {
  it('commits the invitation, its audit event, and its request together', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        organization_id: ORGANIZATION_ID,
        email: INVITEE,
        role: 'member',
        status: 'pending',
        email_delivery_status: 'queued',
      },
    });
    expect(await countRows('organization_invitations')).toBe(1);
    expect(await countRows('organization_audit_events')).toBe(1);

    const requests = await queuedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'organization_invite_email',
      status: 'queued',
    });
    // The payload is ciphertext on disk; only the keyring resolves it.
    expect(requests[0]?.payload_ciphertext).not.toContain(INVITEE);
    expect(sealedPayload(requests[0])).toMatchObject({
      email: INVITEE,
      organizationName: 'Acme',
      role: 'member',
    });
    expect(sealedPayload(requests[0]).token).toEqual(expect.any(String));
    // The provider is no longer called in the request path.
    expect(sender.calls).toHaveLength(0);
  });

  it('emails the credential it committed rather than a re-minted one', async () => {
    const response = await invite();

    const sealed = sealedPayload((await queuedRequests())[0]);
    const stored = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM organization_invitations',
    );
    // The emailed token is the committed one: hashing what the worker will read
    // out of the ciphertext must produce the hash the invitation row stores.
    expect(
      createHash('sha256').update(sealed.token, 'utf8').digest('hex'),
    ).toBe(stored.rows[0]?.token_hash);
    expect(response.json().data.invitation_id).toEqual(
      expect.stringMatching(/^oiv_[0-9A-HJKMNP-TV-Z]{26}$/),
    );
  });

  it('rolls the invitation and its audit event back when the outbox write fails', async () => {
    identityClient.failOutboxInserts = true;

    const response = await invite();

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.payload).not.toContain('email delivery request store');
    expect(await countRows('organization_invitations')).toBe(0);
    expect(await countRows('organization_audit_events')).toBe(0);
    expect(await countRows('email_delivery_requests')).toBe(0);
  });

  it('replays the original result for the same key without a second request', async () => {
    const key = { 'idempotency-key': 'invite-once-key' };

    const first = await invite(key);
    const second = await invite(key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    // The original result, correlation id aside: that one is per request.
    expect(second.json().data).toEqual(first.json().data);
    expect(await countRows('organization_invitations')).toBe(1);
    expect(await queuedRequests()).toHaveLength(1);
    // A replayed key spends no further allowance (ADR-0074).
    expect(rateLimiter.consumed).toBe(3);
  });
});
