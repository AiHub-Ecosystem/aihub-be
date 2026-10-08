import { AppError } from '@/common/errors/app-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { requireActiveMembership } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-21T00:00:00.000Z'),
  deadlineMs: 5_000,
  userId: 'usr_01J00000000000000000000000',
  scopes: [],
});

const input = {
  context,
  userId: 'usr_01J00000000000000000000000',
  organizationId: 'org_acme',
} as const;

function portWith(
  resolution: Awaited<
    ReturnType<OrganizationMembershipPort['resolveMembership']>
  >,
): Pick<OrganizationMembershipPort, 'resolveMembership'> {
  return { resolveMembership: async () => resolution };
}

describe('requireActiveMembership', () => {
  it('returns active membership state', async () => {
    await expect(
      requireActiveMembership(
        portWith({
          kind: 'active',
          membership: {
            organizationId: 'org_acme',
            userId: input.userId,
            organizationStatus: 'active',
            role: 'member',
            status: 'active',
          },
        }),
        input,
      ),
    ).resolves.toMatchObject({ organizationId: 'org_acme', role: 'member' });
  });

  it.each([
    { kind: 'missing' as const },
    {
      kind: 'disabled' as const,
      membership: {
        organizationId: 'org_acme',
        userId: input.userId,
        organizationStatus: 'active' as const,
        role: 'member' as const,
        status: 'disabled' as const,
      },
    },
  ])('maps $kind membership to generic FORBIDDEN', async (resolution) => {
    await expect(
      requireActiveMembership(portWith(resolution), input),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Organization membership is required',
    });
  });

  it('preserves durable lookup failures as internal errors', async () => {
    const failure = new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Identity store is unavailable',
      retryable: false,
    });

    await expect(
      requireActiveMembership(
        {
          resolveMembership: async () => {
            throw failure;
          },
        },
        input,
      ),
    ).rejects.toBe(failure);
  });
});
