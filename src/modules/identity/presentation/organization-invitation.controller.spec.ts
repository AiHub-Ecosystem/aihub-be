import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { AppError } from '../../../common/errors/app-error';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '../../auth/application/auth-rate-limiter.port';
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
  IDEMPOTENCY_SERVICE,
  type IdempotencyExecutionInput,
  type IdempotencyReplayDecoder,
  type IdempotencyServicePort,
  type IdempotencyWork,
} from '../../idempotency/application/idempotency-service.port';
import {
  type CreateOrganizationInvitationInput,
  ORGANIZATION_INVITATION,
  type OpenOrganizationInvitationRecord,
  type OrganizationInvitationPort,
  type RevokeOrganizationInvitationInput,
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
const INVITATION_ID = 'oiv_01J00000000000000000000000';
const REVOKE_URL = `${INVITE_URL}/${INVITATION_ID}`;

type OrganizationStatus = 'active' | 'suspended';
type CallerOverride = {
  readonly role?: OrganizationMembershipRole;
  readonly membershipExists?: boolean;
  readonly status?: OrganizationMembershipStatus;
  readonly organization?: OrganizationStatus;
};

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

describe('Organization invitation HTTP flow', () => {
  let app: NestFastifyApplication;
  let invitations: jest.Mocked<OrganizationInvitationPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let emailSender: jest.Mocked<EmailSenderPort>;
  let tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort>;
  let idempotency: jest.Mocked<IdempotencyServicePort>;
  let rateLimiter: RateLimiterFake;
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
      listOpenInvitations: jest.fn(
        async (
          _input,
        ): Promise<readonly OpenOrganizationInvitationRecord[]> => [],
      ),
      acceptInvitation: jest.fn(),
      revokeInvitation: jest.fn(
        async (_input: RevokeOrganizationInvitationInput) => ({
          kind: 'closed' as const,
        }),
      ),
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
    idempotency = {
      execute: jest.fn(),
    } as jest.Mocked<IdempotencyServicePort>;
    rateLimiter = new RateLimiterFake();
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
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(rateLimiter)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotency)
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
    rateLimiter.allowed = true;
    verifiedTokens = [];
    invitations.createInvitation.mockResolvedValue({
      kind: 'created',
      organizationName: 'Acme',
    });
    invitations.listOpenInvitations.mockResolvedValue([]);
    invitations.revokeInvitation.mockResolvedValue({ kind: 'closed' });
    emailSender.sendOrganizationInviteEmail.mockResolvedValue(undefined);
    idempotency.execute.mockImplementation(
      async <T>(
        input: IdempotencyExecutionInput,
        work: IdempotencyWork<T>,
        _decodeReplay: IdempotencyReplayDecoder<T>,
      ) => ({
        result: await work({
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        }),
        replay: false,
      }),
    );
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

  function list(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = INVITE_URL,
  ) {
    return app.inject({ method: 'GET', url, headers });
  }

  function revoke(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = REVOKE_URL,
  ) {
    return app.inject({ method: 'DELETE', url, headers });
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

  it('returns the generic rate-limited error without creating or sending an invitation', async () => {
    rateLimiter.allowed = false;

    const response = await invite();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        retry_after_ms: 12_345,
      },
    });
    expect(response.body).not.toContain('invitee@example.com');
    expect(invitations.createInvitation).not.toHaveBeenCalled();
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });

  it('passes a canonical management scope and normalized payload to idempotency', async () => {
    await invite(
      { email: '  Invitee@Example.COM  ', role: 'member' },
      {
        authorization: 'Bearer valid.token.value',
        'idempotency-key': 'invite-1',
      },
    );

    expect(idempotency.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        operation: 'organizations.invitations.create',
        scope: 'management',
        actorId: USER_ID,
        idempotencyKey: 'invite-1',
        requestBody: { email: 'invitee@example.com', role: 'member' },
        responseStatus: 201,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('replays invitation data without invoking the invitation mutation twice', async () => {
    const replayed = {
      invitationId: INVITATION_ID,
      organizationId: ORGANIZATION_ID,
      email: 'invitee@example.com',
      role: 'member' as const,
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    };
    idempotency.execute.mockResolvedValueOnce({
      result: replayed,
      replay: true,
    });

    const response = await invite(undefined, {
      authorization: 'Bearer valid.token.value',
      'idempotency-key': 'invite-1',
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotent-replay']).toBe('true');
    expect(response.json()).toEqual({
      data: {
        invitation_id: INVITATION_ID,
        organization_id: ORGANIZATION_ID,
        email: 'invitee@example.com',
        role: 'member',
        status: 'pending',
        expires_at: '2026-09-22T12:00:00.000Z',
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(invitations.createInvitation).not.toHaveBeenCalled();
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
  });

  it('rechecks current authorization before replay', async () => {
    callerStatus = 'disabled';

    const response = await invite(undefined, {
      authorization: 'Bearer valid.token.value',
      'idempotency-key': 'invite-1',
    });

    expect(response.statusCode).toBe(403);
    expect(idempotency.execute).not.toHaveBeenCalled();
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

  it('lists redacted actionable invitations for an owner', async () => {
    invitations.listOpenInvitations.mockResolvedValue([
      {
        invitationId: 'oiv_01J00000000000000000000000',
        email: 'invitee@example.com',
        role: 'admin',
        invitedByUsername: 'owner',
        createdAt: new Date('2026-09-21T11:00:00.000Z'),
        expiresAt: new Date('2026-09-22T11:00:00.000Z'),
      },
    ]);

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        invitations: [
          {
            invitation_id: 'oiv_01J00000000000000000000000',
            email: 'invitee@example.com',
            role: 'admin',
            invited_by_username: 'owner',
            created_at: '2026-09-21T11:00:00.000Z',
            expires_at: '2026-09-22T11:00:00.000Z',
            status: 'pending',
          },
        ],
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(response.payload).not.toContain(USER_ID);
    expect(response.payload).not.toContain('token');
    expect(invitations.listOpenInvitations).toHaveBeenCalledWith({
      context: expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      now: expect.any(Date),
    });
  });

  it('lists the same invitation metadata for an admin', async () => {
    callerRole = 'admin';
    invitations.listOpenInvitations.mockResolvedValue([
      {
        invitationId: 'oiv_01J00000000000000000000000',
        email: 'invitee@example.com',
        role: 'member',
        invitedByUsername: 'owner',
        createdAt: new Date('2026-09-21T11:00:00.000Z'),
        expiresAt: new Date('2026-09-22T11:00:00.000Z'),
      },
    ]);

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json().data.invitations[0]).toMatchObject({
      role: 'member',
      status: 'pending',
    });
  });

  it('returns an empty successful listing', async () => {
    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { invitations: [] },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns bodyless 204 when an owner revokes an invitation', async () => {
    const response = await revoke();

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(invitations.revokeInvitation).toHaveBeenCalledWith({
      context: expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      actorUserId: USER_ID,
      actorRole: 'owner',
      organizationId: ORGANIZATION_ID,
      invitationId: INVITATION_ID,
      now: expect.any(Date),
    });
  });

  it('keeps revocation available to an admin', async () => {
    callerRole = 'admin';

    const response = await revoke();

    expect(response.statusCode).toBe(204);
  });

  it.each<[string, CallerOverride]>([
    ['a non-member', { membershipExists: false }],
    ['a disabled membership', { status: 'disabled' as const }],
    ['a suspended organization', { organization: 'suspended' as const }],
  ])(
    'denies revocation for %s before reading the invitation',
    async (_label, override) => {
      callerRole = override.role ?? callerRole;
      callerMembershipExists =
        override.membershipExists ?? callerMembershipExists;
      callerStatus = override.status ?? callerStatus;
      organizationStatus = override.organization ?? organizationStatus;

      const response = await revoke();

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization invitation revocation is forbidden',
      });
      expect(invitations.revokeInvitation).not.toHaveBeenCalled();
    },
  );

  it('returns the safe policy denial when a member target is refused', async () => {
    callerRole = 'member';
    invitations.revokeInvitation.mockRejectedValue(
      new AppError({
        code: 'FORBIDDEN',
        message: 'Organization invitation revocation is forbidden',
        retryable: false,
      }),
    );

    const response = await revoke();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(invitations.revokeInvitation).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or invalid Bearer credentials before revocation', async () => {
    const missing = await revoke({});
    const invalid = await revoke({ authorization: 'Bearer nope' });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(invitations.revokeInvitation).not.toHaveBeenCalled();
  });

  it('maps an unknown invitation to not found', async () => {
    invitations.revokeInvitation.mockResolvedValue({ kind: 'not_found' });

    const response = await revoke();

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it.each<[string, CallerOverride]>([
    ['a member', { role: 'member' as const }],
    ['a non-member', { membershipExists: false }],
    ['a disabled membership', { status: 'disabled' as const }],
    ['a suspended organization', { organization: 'suspended' as const }],
  ])('denies %s without reading invitations', async (_label, override) => {
    callerRole = override.role ?? callerRole;
    callerMembershipExists =
      override.membershipExists ?? callerMembershipExists;
    callerStatus = override.status ?? callerStatus;
    organizationStatus = override.organization ?? organizationStatus;

    const response = await list();

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization invitation access is forbidden',
    });
    expect(invitations.listOpenInvitations).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid Bearer credentials before reading invitations', async () => {
    const missing = await list({});
    const invalid = await list({ authorization: 'Bearer nope' });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(invitations.listOpenInvitations).not.toHaveBeenCalled();
  });

  it('fails safely when the invitation projection cannot be read', async () => {
    invitations.listOpenInvitations.mockRejectedValue(
      new Error('database unavailable'),
    );

    const response = await list();

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.payload).not.toContain('database unavailable');
  });

  it.each(['owner', 'admin'] as const)(
    'forbids an admin from inviting role %s',
    async (role) => {
      callerRole = 'admin';

      const response = await invite({ email: 'invitee@example.com', role });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization admins can only invite members',
      });
      expect(invitations.createInvitation).not.toHaveBeenCalled();
      expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
    },
  );

  it.each<[string, CallerOverride]>([
    ['a member', { role: 'member' as const }],
    ['a non-member', { membershipExists: false }],
    ['a disabled membership', { status: 'disabled' as const }],
    ['a suspended organization', { organization: 'suspended' as const }],
  ])('gives %s the same invite denial', async (_label, override) => {
    callerRole = override.role ?? callerRole;
    callerMembershipExists =
      override.membershipExists ?? callerMembershipExists;
    callerStatus = override.status ?? callerStatus;
    organizationStatus = override.organization ?? organizationStatus;

    const response = await invite();

    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'Organization invitation sending is forbidden',
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    });
    expect(invitations.createInvitation).not.toHaveBeenCalled();
    expect(emailSender.sendOrganizationInviteEmail).not.toHaveBeenCalled();
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
