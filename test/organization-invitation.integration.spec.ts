import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import { type EmailPayloadCipher } from '@/modules/auth/application/email-delivery-request.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
  type OrganizationInviteEmailInput,
} from '@/modules/auth/application/email-sender.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from '@/modules/identity/application/organization-invitation.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '@/modules/identity/application/organization-membership.port';
import type { PostgresIdentityTransactionalClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationInvitationRepository } from '@/modules/identity/infrastructure/postgres-organization-invitation.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const INVITE_URL = `/v1/organizations/${ORGANIZATION_ID}/invitations`;

class FakeIdentityDatabase implements PostgresIdentityTransactionalClient {
  transactionCalls = 0;
  invitationRows = 0;
  auditEvents = 0;
  emailDeliveryRequests = 0;

  async query(
    _text: string,
    _values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> {
    return [];
  }

  async transaction<T>(
    callback: Parameters<PostgresIdentityTransactionalClient['transaction']>[0],
  ): Promise<T> {
    this.transactionCalls += 1;
    return callback({
      query: async (text: string, _values: readonly unknown[]) => {
        if (text.includes('FROM organizations')) {
          return [{ id: ORGANIZATION_ID, name: 'Acme' }];
        }
        if (text.includes('INSERT INTO organization_invitations')) {
          this.invitationRows += 1;
        }
        if (text.includes('INSERT INTO organization_audit_events')) {
          this.auditEvents += 1;
        }
        if (text.includes('INSERT INTO email_delivery_requests')) {
          this.emailDeliveryRequests += 1;
        }
        return [];
      },
    }) as Promise<T>;
  }
}

class RateLimiterFake implements AuthRateLimiterPort {
  allowed = true;

  async consume(
    _input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }> {
    return this.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterMs: 12_345 };
  }
}

/** The AEAD has its own tests; this suite is about what is committed with what. */
class StubCipher implements EmailPayloadCipher {
  encrypt(plaintext: string): string {
    return `sealed.${plaintext}`;
  }

  decrypt(): string {
    throw new Error('the repository never reads a payload back');
  }
}

describe('organization invitation HTTP/application/repository integration', () => {
  let app: NestFastifyApplication;
  let database: FakeIdentityDatabase;
  let rateLimiter: RateLimiterFake;
  let emailSender: jest.Mocked<
    Pick<EmailSenderPort, 'sendOrganizationInviteEmail'>
  >;

  beforeAll(async () => {
    database = new FakeIdentityDatabase();
    rateLimiter = new RateLimiterFake();
    emailSender = {
      sendOrganizationInviteEmail: jest.fn(
        async (_input: OrganizationInviteEmailInput) => undefined,
      ),
    };

    const membership: Pick<OrganizationMembershipPort, 'resolveMembership'> = {
      resolveMembership: async ({ organizationId, userId }) => ({
        kind: 'active',
        membership: {
          organizationId,
          userId,
          organizationStatus: 'active',
          role: 'owner',
          status: 'active',
        },
      }),
    };
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };
    const userAccounts = userAccountStatus();
    const invitations: OrganizationInvitationPort =
      new PostgresOrganizationInvitationRepository(database, new StubCipher());

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_INVITATION)
      .useValue(invitations)
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(rateLimiter)
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    database.transactionCalls = 0;
    database.invitationRows = 0;
    database.auditEvents = 0;
    database.emailDeliveryRequests = 0;
    rateLimiter.allowed = true;
    emailSender.sendOrganizationInviteEmail.mockClear();
  });

  function invite() {
    return app.inject({
      method: 'POST',
      url: INVITE_URL,
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { email: 'invitee@example.com', role: 'member' },
    });
  }

  it('persists the invitation, its audit event, and its request in one transaction', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { email_delivery_status: 'queued' },
    });
    expect(database.transactionCalls).toBe(1);
    expect(database.invitationRows).toBe(1);
    expect(database.auditEvents).toBe(1);
    expect(database.emailDeliveryRequests).toBe(1);
    // The provider is not called in the request path; a worker claims the row.
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });

  it('rejects a rate-limited invitation before any durable side effect', async () => {
    rateLimiter.allowed = false;

    const response = await invite();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        retry_after_ms: 12_345,
      },
    });
    expect(database.transactionCalls).toBe(0);
    expect(database.invitationRows).toBe(0);
    expect(database.auditEvents).toBe(0);
    expect(database.emailDeliveryRequests).toBe(0);
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });
});
