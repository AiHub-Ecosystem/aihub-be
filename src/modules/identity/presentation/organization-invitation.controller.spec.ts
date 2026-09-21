import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
  type OrganizationInviteEmailInput,
  type PasswordResetEmailInput,
  type VerificationEmailInput,
} from '../../auth/application/email-sender.port';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../../auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import {
  type CreateOrganizationInvitationInput,
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from '../application/organization-invitation.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '../application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const INVITE_URL = `/v1/organizations/${ORGANIZATION_ID}/invitations`;

type OrganizationStatus = 'active' | 'suspended';

describe('Organization invitation HTTP flow', () => {
  let app: NestFastifyApplication;
  let invitations: jest.Mocked<OrganizationInvitationPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let emailSender: jest.Mocked<EmailSenderPort>;
  let tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort>;
  let verifiedTokens: string[];

  let callerRole: OrganizationMembershipRole = 'owner';
  let callerStatus: OrganizationMembershipStatus = 'active';
  let callerMembershipExists = true;
  let organizationStatus: OrganizationStatus = 'active';

  beforeAll(async () => {
    membership = {
      resolveMembership: jest.fn(async ({ organizationId, userId }) => {
        if (!callerMembershipExists) {
          return { kind: 'missing' as const };
        }
        const record = {
          organizationId,
          userId,
          organizationStatus,
          role: callerRole,
          status: callerStatus,
        };
        return callerStatus === 'active'
          ? { kind: 'active' as const, membership: record }
          : { kind: 'disabled' as const, membership: record };
      }),
      listRoster: jest.fn(async (_input: ListRosterInput) => []),
      changeRole: jest.fn(),
      disable: jest.fn(),
      transfer: jest.fn(),
    };
    invitations = {
      createInvitation: jest.fn(
        async (_input: CreateOrganizationInvitationInput) => ({
          kind: 'created' as const,
          organizationName: 'Acme',
        }),
      ),
      acceptInvitation: jest.fn(),
    };
    emailSender = {
      sendVerificationEmail: jest.fn(
        async (_input: VerificationEmailInput) => undefined,
      ),
      sendPasswordResetEmail: jest.fn(
        async (_input: PasswordResetEmailInput) => undefined,
      ),
      sendOrganizationInviteEmail: jest.fn(
        async (_input: OrganizationInviteEmailInput) => undefined,
      ),
    };

    tokenIssuer = {
      issue: jest.fn(async (_userId: string) => ({
        token: 'reissued.token.value',
        expiresIn: 900,
      })),
    };
    verifiedTokens = [];
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        verifiedTokens.push(token);
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };
    const localAuthRepository: Pick<
      LocalAuthRepositoryPort,
      'findUserAccountStatus'
    > = {
      findUserAccountStatus: async () => 'active',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_INVITATION)
      .useValue(invitations)
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(EMAIL_SENDER)
      .useValue(emailSender)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(localAuthRepository)
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
    callerRole = 'owner';
    callerStatus = 'active';
    callerMembershipExists = true;
    organizationStatus = 'active';
    jest.clearAllMocks();
    verifiedTokens = [];
    invitations.createInvitation.mockResolvedValue({
      kind: 'created',
      organizationName: 'Acme',
    });
    emailSender.sendOrganizationInviteEmail.mockResolvedValue(undefined);
  });

  function invite(
    payload: object = { email: 'invitee@example.com', role: 'member' },
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = INVITE_URL,
  ) {
    return app.inject({ method: 'POST', url, headers, payload });
  }

  function createInvitationCall(): CreateOrganizationInvitationInput {
    const call = invitations.createInvitation.mock.calls[0];
    if (call === undefined) {
      throw new Error('createInvitation was not called');
    }
    return call[0];
  }

  it('creates a pending invitation for an owner and never returns the raw token', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        invitation_id: expect.stringMatching(/^oiv_[0-9A-HJKMNP-TV-Z]{26}$/),
        organization_id: ORGANIZATION_ID,
        email: 'invitee@example.com',
        role: 'member',
        status: 'pending',
        expires_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(response.body).not.toContain('token');
  });

  it('persists only the token hash and hands the raw token to the email sender', async () => {
    await invite();

    const persisted = createInvitationCall();
    expect(persisted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.organizationId).toBe(ORGANIZATION_ID);
    expect(persisted.invitedBy).toBe(USER_ID);
    expect(persisted.role).toBe('member');

    const emailCall =
      emailSender.sendOrganizationInviteEmail.mock.calls[0]?.[0];
    expect(emailCall).toBeDefined();
    expect(emailCall?.email).toBe('invitee@example.com');
    expect(emailCall?.organizationName).toBe('Acme');
    expect(emailCall?.role).toBe('member');
    expect(emailCall?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(emailCall?.token).not.toBe(persisted.tokenHash);
    expect(emailCall?.expiresAt).toEqual(persisted.expiresAt);
  });

  it('expires the invite token 24 hours after issuance', async () => {
    await invite();

    const persisted = createInvitationCall();
    expect(persisted.expiresAt.getTime() - persisted.now.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('carries the explicit organization through the request context', async () => {
    await invite();

    expect(createInvitationCall().context.organizationId).toBe(ORGANIZATION_ID);
  });

  it('normalizes the invited email before it becomes durable', async () => {
    await invite({ email: '  Invitee@Example.COM  ', role: 'member' });

    expect(createInvitationCall().email).toBe('invitee@example.com');
  });

  it.each(['owner', 'admin', 'member'] as const)(
    'lets an owner invite role %s',
    async (role) => {
      const response = await invite({ email: 'invitee@example.com', role });

      expect(response.statusCode).toBe(201);
      expect(createInvitationCall().role).toBe(role);
    },
  );

  it('lets an admin invite an ordinary member', async () => {
    callerRole = 'admin';

    const response = await invite({
      email: 'invitee@example.com',
      role: 'member',
    });

    expect(response.statusCode).toBe(201);
  });

  it.each(['owner', 'admin'] as const)(
    'forbids an admin from inviting role %s',
    async (role) => {
      callerRole = 'admin';

      const response = await invite({ email: 'invitee@example.com', role });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(invitations.createInvitation).not.toHaveBeenCalled();
      expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
    },
  );

  it('forbids a member from inviting anyone', async () => {
    callerRole = 'member';

    const response = await invite();

    expect(response.statusCode).toBe(403);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('forbids a non-member', async () => {
    callerMembershipExists = false;

    const response = await invite();

    expect(response.statusCode).toBe(403);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('forbids a caller whose membership is disabled', async () => {
    callerStatus = 'disabled';

    const response = await invite();

    expect(response.statusCode).toBe(403);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('forbids inviting into a suspended organization', async () => {
    organizationStatus = 'suspended';

    const response = await invite();

    expect(response.statusCode).toBe(403);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects a missing Bearer credential', async () => {
    const response = await invite(
      { email: 'invitee@example.com', role: 'member' },
      {},
    );

    expect(response.statusCode).toBe(401);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects an invalid Bearer credential', async () => {
    const response = await invite(
      { email: 'invitee@example.com', role: 'member' },
      { authorization: 'Bearer nope' },
    );

    expect(response.statusCode).toBe(401);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('reports a conflict when the email already holds an active membership', async () => {
    invitations.createInvitation.mockResolvedValue({ kind: 'member_exists' });

    const response = await invite();

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ORGANIZATION_MEMBER_EXISTS');
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });

  it('keeps the conflict outcome unreachable without invite authority', async () => {
    callerRole = 'member';
    invitations.createInvitation.mockResolvedValue({ kind: 'member_exists' });

    const response = await invite();

    expect(response.statusCode).toBe(403);
  });

  it.each([
    ['a malformed email', { email: 'not-an-email', role: 'member' }],
    ['an empty email', { email: '', role: 'member' }],
    ['an unknown role', { email: 'invitee@example.com', role: 'root' }],
    ['a missing role', { email: 'invitee@example.com' }],
    ['a missing email', { role: 'member' }],
    [
      'an unexpected field',
      {
        email: 'invitee@example.com',
        role: 'member',
        status: 'active',
      },
    ],
  ])(
    'rejects %s without creating anything durable',
    async (_label, payload) => {
      const response = await invite(payload);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(invitations.createInvitation).not.toHaveBeenCalled();
      expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid payload before the invited email is looked up', async () => {
    callerRole = 'admin';

    const response = await invite({ email: 'not-an-email', role: 'member' });

    expect(response.statusCode).toBe(400);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('surfaces a retryable error when invite email delivery fails', async () => {
    emailSender.sendOrganizationInviteEmail.mockRejectedValue(
      new Error('resend down'),
    );

    const response = await invite();

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('AUTH_EMAIL_DELIVERY_UNAVAILABLE');
    expect(response.json().error.retryable).toBe(true);
    // The invitation stays durable; a retry supersedes its token.
    expect(invitations.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('does not leak the raw token through a delivery failure response', async () => {
    emailSender.sendOrganizationInviteEmail.mockRejectedValue(
      new Error('resend down'),
    );

    const response = await invite();
    const rawToken =
      emailSender.sendOrganizationInviteEmail.mock.calls[0]?.[0].token;

    expect(rawToken).toBeDefined();
    expect(response.body).not.toContain(rawToken);
  });

  it('supersedes the undelivered token when the caller retries after a delivery failure', async () => {
    emailSender.sendOrganizationInviteEmail.mockRejectedValueOnce(
      new Error('resend down'),
    );

    const failed = await invite();
    const second = await invite();

    expect(failed.statusCode).toBe(503);
    expect(second.statusCode).toBe(201);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(2);

    const first = invitations.createInvitation.mock.calls[0]?.[0];
    const retry = invitations.createInvitation.mock.calls[1]?.[0];
    expect(retry?.tokenHash).not.toBe(first?.tokenHash);
    expect(retry?.email).toBe(first?.email);
  });

  it('normalizes a differently-cased resend onto the same durable email', async () => {
    await invite({ email: 'invitee@example.com', role: 'member' });
    await invite({ email: 'INVITEE@Example.com', role: 'member' });

    const [first, second] = invitations.createInvitation.mock.calls;
    expect(first?.[0].email).toBe('invitee@example.com');
    expect(second?.[0].email).toBe('invitee@example.com');
  });

  it('keeps the raw token out of captured log output', async () => {
    const written: string[] = [];
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    try {
      await invite();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    const rawToken =
      emailSender.sendOrganizationInviteEmail.mock.calls[0]?.[0].token;
    expect(rawToken).toBeDefined();
    expect(written.join('')).not.toContain(rawToken);
  });

  it('keeps the conflict outcome unreachable for a non-member', async () => {
    callerMembershipExists = false;
    invitations.createInvitation.mockResolvedValue({ kind: 'member_exists' });

    const response = await invite();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('leaves User Access JWT issuance untouched', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    // Inviting authorizes against durable membership; it never mints, rotates,
    // or re-scopes the caller's own credential.
    expect(tokenIssuer.issue).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toContain('access_token');
    expect(verifiedTokens).toEqual(['valid.token.value']);
  });
});
