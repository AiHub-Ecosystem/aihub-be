import { AppError } from '@/common/errors/app-error';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  AuthRateLimitScope,
  AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import { ORGANIZATION_INVITATION_CREATE_OPERATION } from '@/modules/idempotency/application/idempotency-operation';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
import {
  InviteOrganizationMember,
  type InvitedOrganizationMember,
} from './invite-organization-member';
import type {
  CreateOrganizationInvitationInput,
  OrganizationInvitationPort,
} from './organization-invitation.port';
import type {
  IssuedOrganizationInviteToken,
  OrganizationInviteTokenPort,
} from './organization-invite-token.port';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
} from './organization-membership.port';

const ORGANIZATION_ID = 'org_acme';
const OTHER_ORGANIZATION_ID = 'org_other';
const USER_ID = 'usr_owner';
const OTHER_USER_ID = 'usr_other';
const REQUEST_ID = 'req_01J00000000000000000000000';

type StoredRecord =
  | {
      readonly state: 'pending' | 'failed';
      readonly fingerprintHex: string;
      readonly requestId: string;
    }
  | {
      readonly state: 'completed';
      readonly fingerprintHex: string;
      readonly requestId: string;
      readonly responseStatus: number;
      readonly responseBody: unknown;
    };

class ManagementRepository implements IdempotencyRepositoryPort {
  readonly records = new Map<string, StoredRecord>();
  failReserve = false;
  failComplete = false;

  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<IdempotencyReservation> {
    if (this.failReserve) {
      throw new Error('reservation storage unavailable');
    }

    const key = this.key(input);
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, {
        state: 'pending',
        fingerprintHex: input.fingerprintHex,
        requestId: input.requestId,
      });
      return { kind: 'claimed', requestId: input.requestId };
    }

    if (existing.fingerprintHex !== input.fingerprintHex) {
      return { kind: 'conflict', reason: 'fingerprint' };
    }
    if (existing.state === 'pending') {
      return { kind: 'conflict', reason: 'pending' };
    }
    if (existing.state === 'failed') {
      this.records.set(key, {
        state: 'pending',
        fingerprintHex: input.fingerprintHex,
        requestId: input.requestId,
      });
      return { kind: 'claimed', requestId: input.requestId };
    }
    if (existing.state !== 'completed') {
      throw new Error('claim state is invalid');
    }
    return {
      kind: 'replay',
      responseStatus: existing.responseStatus,
      responseBody: existing.responseBody,
    };
  }

  async complete(input: CompleteIdempotencyInput): Promise<void> {
    if (this.failComplete) {
      throw new Error('completion storage unavailable');
    }
    const key = this.key(input);
    const existing = this.records.get(key);
    if (
      existing?.state !== 'pending' ||
      existing.requestId !== input.requestId
    ) {
      throw new Error('claim is not pending');
    }
    this.records.set(key, {
      state: 'completed',
      fingerprintHex: existing.fingerprintHex,
      requestId: input.requestId,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
    });
  }

  async markFailed(input: IdempotencyAttemptInput): Promise<void> {
    const key = this.key(input);
    const existing = this.records.get(key);
    if (
      existing?.state !== 'pending' ||
      existing.requestId !== input.requestId
    ) {
      throw new Error('claim is not pending');
    }
    this.records.set(key, {
      state: 'failed',
      fingerprintHex: existing.fingerprintHex,
      requestId: input.requestId,
    });
  }

  async delete(input: IdempotencyAttemptInput): Promise<void> {
    this.records.delete(this.key(input));
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }

  private key(input: {
    readonly organizationId: string | null;
    readonly operation: string;
    readonly actorScope?: string;
    readonly idempotencyKey: string;
  }): string {
    return [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
    ].join(':');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeInvitation(value: unknown): InvitedOrganizationMember {
  if (!isRecord(value)) {
    throw new Error('invalid stored invitation');
  }
  const { invitationId, organizationId, email, role, expiresAt } = value;
  if (
    typeof invitationId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'owner' && role !== 'admin' && role !== 'member') ||
    value.emailDeliveryStatus !== 'queued'
  ) {
    throw new Error('invalid stored invitation');
  }
  const parsedExpiresAt =
    expiresAt instanceof Date
      ? expiresAt
      : typeof expiresAt === 'string'
        ? new Date(expiresAt)
        : undefined;
  if (
    parsedExpiresAt === undefined ||
    Number.isNaN(parsedExpiresAt.getTime())
  ) {
    throw new Error('invalid stored invitation');
  }
  return {
    invitationId,
    organizationId,
    email,
    role,
    expiresAt: parsedExpiresAt,
    emailDeliveryStatus: 'queued',
  };
}

function context(organizationId: string, requestId: string): RequestContext {
  const receivedAt = new Date();
  return {
    requestId,
    receivedAt,
    deadlineAt: new Date(receivedAt.getTime() + 5_000),
    organizationId,
    scopes: [],
    signal: new AbortController().signal,
  };
}

class RateLimiterFake implements AuthRateLimiterPort {
  private readonly counts = new Map<string, number>();
  rejectScope: AuthRateLimitScope | undefined;

  async consume(
    input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }> {
    const counterKey = `${input.scope}:${input.key}`;
    const count = (this.counts.get(counterKey) ?? 0) + 1;
    this.counts.set(counterKey, count);
    return input.scope === this.rejectScope || count > input.limit
      ? { allowed: false, retryAfterMs: 12_345 }
      : { allowed: true };
  }
}

function storeUnavailable(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Identity store is unavailable',
    retryable: false,
  });
}

describe('organization invitation management idempotency seam', () => {
  let repository: ManagementRepository;
  let service: IdempotencyService;
  let inviteMember: InviteOrganizationMember;
  let membership: jest.Mocked<
    Pick<OrganizationMembershipPort, 'resolveMembership'>
  >;
  let invitations: jest.Mocked<OrganizationInvitationPort>;
  let tokenIssuer: jest.Mocked<OrganizationInviteTokenPort>;
  let rateLimiter: RateLimiterFake;
  let issuedTokenCount: number;

  beforeEach(() => {
    repository = new ManagementRepository();
    service = new IdempotencyService(repository);
    rateLimiter = new RateLimiterFake();
    issuedTokenCount = 0;
    membership = {
      resolveMembership: jest.fn(
        async ({
          organizationId,
          userId,
        }): Promise<{
          readonly kind: 'active';
          readonly membership: OrganizationMembershipRecord;
        }> => ({
          kind: 'active',
          membership: {
            organizationId,
            userId,
            organizationStatus: 'active',
            role: 'owner',
            status: 'active',
          },
        }),
      ),
    };
    invitations = {
      createInvitation: jest.fn(
        async (_input: CreateOrganizationInvitationInput) =>
          ({ kind: 'created' }) as const,
      ),
      listOpenInvitations: jest.fn(),
      acceptInvitation: jest.fn(),
      revokeInvitation: jest.fn(),
    };
    tokenIssuer = {
      issue: jest.fn((now: Date): IssuedOrganizationInviteToken => {
        issuedTokenCount += 1;
        return {
          id: `oiv_${issuedTokenCount}`,
          raw: `raw-token-${issuedTokenCount}`,
          hash: `hash-${issuedTokenCount}`,
          expiresAt: new Date(now.getTime() + 86_400_000),
        };
      }),
      hash: jest.fn((raw: string) => raw),
    };
    inviteMember = new InviteOrganizationMember(
      membership,
      invitations,
      tokenIssuer,
      rateLimiter,
      prefixedIdGenerator('edr_'),
    );
  });

  function execute(input: {
    readonly organizationId?: string;
    readonly userId?: string;
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly email?: string;
    readonly role?: 'owner' | 'admin' | 'member';
  }) {
    const organizationId = input.organizationId ?? ORGANIZATION_ID;
    const userId = input.userId ?? USER_ID;
    const requestId = input.requestId ?? REQUEST_ID;
    const email = input.email ?? 'invitee@example.com';
    const normalizedEmail = email.trim().toLowerCase();
    const role = input.role ?? 'member';
    const requestContext = context(organizationId, requestId);
    const command = {
      context: requestContext,
      userId,
      organizationId,
      email,
      role,
    };
    const idempotencyInput = {
      organizationId,
      operation: ORGANIZATION_INVITATION_CREATE_OPERATION,
      scope: 'management' as const,
      actorId: userId,
      requestBody: { email: normalizedEmail, role },
      requestId,
      timeoutMs: 5_000,
      responseStatus: 201,
      signal: requestContext.signal,
      deadlineAt: requestContext.deadlineAt,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    };
    return service.execute(
      idempotencyInput,
      (workContext) =>
        inviteMember.invite({
          ...command,
          context: {
            ...requestContext,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          },
        }),
      decodeInvitation,
    );
  }

  it('replays the original invitation without a second token or email', async () => {
    const first = await execute({ idempotencyKey: 'invite-1' });
    const replay = await execute({
      idempotencyKey: 'invite-1',
      requestId: 'req_01J00000000000000000000001',
      email: ' INVITEE@example.com ',
    });

    expect(first.replay).toBe(false);
    expect(replay).toEqual({ result: first.result, replay: true });
    expect(issuedTokenCount).toBe(1);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    'organization_invitation_user',
    'organization_invitation_organization',
    'organization_invitation_email',
  ] as const)(
    'rejects before mutation when the %s limit is exceeded',
    async (scope) => {
      rateLimiter.rejectScope = scope;

      await expect(
        execute({ idempotencyKey: 'invite-1' }),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        httpStatus: 429,
        retryAfterMs: 12_345,
      });

      expect(issuedTokenCount).toBe(0);
      expect(invitations.createInvitation).not.toHaveBeenCalled();
    },
  );

  it('shares the normalized email allowance across callers and Organizations', async () => {
    await execute({
      idempotencyKey: 'invite-1',
      email: ' Invitee@Example.COM ',
    });
    await execute({
      idempotencyKey: 'invite-2',
      organizationId: OTHER_ORGANIZATION_ID,
      userId: OTHER_USER_ID,
    });
    await execute({
      idempotencyKey: 'invite-3',
      organizationId: 'org_third',
      userId: 'usr_third',
    });

    await expect(
      execute({
        idempotencyKey: 'invite-4',
        organizationId: 'org_fourth',
        userId: 'usr_fourth',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
    expect(invitations.createInvitation).toHaveBeenCalledTimes(3);
  });

  it('rejects a different role with the same scoped key', async () => {
    await execute({ idempotencyKey: 'invite-1' });

    await expect(
      execute({ idempotencyKey: 'invite-1', role: 'admin' }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    });
    expect(issuedTokenCount).toBe(1);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('keeps the same key independent across callers and Organizations', async () => {
    await execute({ idempotencyKey: 'invite-1' });
    await execute({ idempotencyKey: 'invite-1', userId: OTHER_USER_ID });
    await execute({
      idempotencyKey: 'invite-1',
      organizationId: OTHER_ORGANIZATION_ID,
    });

    expect(issuedTokenCount).toBe(3);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(3);
  });

  it('lets a missing key retain the existing non-idempotent behavior', async () => {
    await execute({});
    await execute({});

    expect(issuedTokenCount).toBe(2);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(2);
  });

  it('allows one concurrent claimant and conflicts the other safely', async () => {
    const results = await Promise.allSettled([
      execute({ idempotencyKey: 'invite-1', requestId: 'req_1' }),
      execute({ idempotencyKey: 'invite-1', requestId: 'req_2' }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 },
    });
    expect(issuedTokenCount).toBe(1);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('fails closed when reservation storage is unavailable', async () => {
    repository.failReserve = true;

    await expect(execute({ idempotencyKey: 'invite-1' })).rejects.toMatchObject(
      { code: 'INTERNAL_ERROR', httpStatus: 500 },
    );
    expect(issuedTokenCount).toBe(0);
    expect(invitations.createInvitation).not.toHaveBeenCalled();
  });

  it('keeps completion uncertainty pending so a retry cannot duplicate the invitation', async () => {
    repository.failComplete = true;

    await expect(execute({ idempotencyKey: 'invite-1' })).rejects.toMatchObject(
      { code: 'INTERNAL_ERROR', httpStatus: 500 },
    );
    repository.failComplete = false;

    await expect(
      execute({
        idempotencyKey: 'invite-1',
        requestId: 'req_01J00000000000000000002',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    expect(issuedTokenCount).toBe(1);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('fails the whole create when the commit fails and lets the same key retry', async () => {
    invitations.createInvitation.mockRejectedValueOnce(storeUnavailable());

    await expect(execute({ idempotencyKey: 'invite-1' })).rejects.toMatchObject(
      {
        code: 'INTERNAL_ERROR',
        httpStatus: 500,
      },
    );
    await expect(
      execute({
        idempotencyKey: 'invite-1',
        requestId: 'req_01J00000000000000000000003',
      }),
    ).resolves.toMatchObject({ replay: false });
    expect(issuedTokenCount).toBe(2);
    expect(invitations.createInvitation).toHaveBeenCalledTimes(2);
  });

  it('consumes the email allowance when the commit fails', async () => {
    invitations.createInvitation.mockRejectedValue(storeUnavailable());

    for (const idempotencyKey of ['invite-1', 'invite-2', 'invite-3']) {
      await expect(execute({ idempotencyKey })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        httpStatus: 500,
      });
    }

    await expect(execute({ idempotencyKey: 'invite-4' })).rejects.toMatchObject(
      { code: 'RATE_LIMITED', httpStatus: 429 },
    );
    expect(invitations.createInvitation).toHaveBeenCalledTimes(3);
  });
});
