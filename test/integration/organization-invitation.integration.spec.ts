import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
  type OrganizationInviteEmailInput,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import {
  type CreateOrganizationInvitationInput,
  type CreateOrganizationInvitationResult,
  ORGANIZATION_INVITATION,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '@/modules/identity/membership/application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const INVITE_URL = `/v1/organizations/${ORGANIZATION_ID}/invitations`;

class RateLimiterFake implements AuthRateLimiterPort {
  allowed = true;

  async check(): Promise<{ readonly allowed: boolean }> {
    return { allowed: this.allowed };
  }

  async consume(
    _input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }> {
    return this.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterMs: 12_345 };
  }
}

describe('organization invitation HTTP/application integration', () => {
  let app: NestFastifyApplication;
  let rateLimiter: RateLimiterFake;
  let createInvitation: jest.Mock<
    Promise<CreateOrganizationInvitationResult>,
    [CreateOrganizationInvitationInput]
  >;
  let emailSender: jest.Mocked<
    Pick<EmailSenderPort, 'sendOrganizationInviteEmail'>
  >;

  beforeAll(async () => {
    rateLimiter = new RateLimiterFake();
    createInvitation = jest.fn(
      async (
        _input: CreateOrganizationInvitationInput,
      ): Promise<CreateOrganizationInvitationResult> => ({
        kind: 'created',
      }),
    );
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

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_INVITATION)
      .useValue({ createInvitation })
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(rateLimiter)
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccountStatus())
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
    rateLimiter.allowed = true;
    createInvitation.mockClear();
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

  it('queues a valid invitation through the application port', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { email_delivery_status: 'queued' },
    });
    expect(createInvitation).toHaveBeenCalledTimes(1);
    // The provider is not called in the request path; a worker claims the row.
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });

  it('rejects a rate-limited invitation before the application port is called', async () => {
    rateLimiter.allowed = false;

    const response = await invite();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        retry_after_ms: 12_345,
      },
    });
    expect(createInvitation).not.toHaveBeenCalled();
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });
});
