import type {
  ResolvedUserIdentity,
  UserIdentityResolverPort,
} from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import { resolveUserIdentity } from './resolve-user-identity';

const resolved: ResolvedUserIdentity = {
  userId: 'student-1',
  organizationId: 'org_acme',
  scopes: [],
  mode: 'declared_id',
};

function resolverReturning(
  identity: ResolvedUserIdentity,
): UserIdentityResolverPort & { calls: number } {
  return {
    calls: 0,
    async resolve() {
      this.calls += 1;
      return identity;
    },
  };
}

describe('resolveUserIdentity', () => {
  it('resolves a header against the caller Organization', async () => {
    await expect(
      resolveUserIdentity('student-1', 'org_acme', resolverReturning(resolved)),
    ).resolves.toBe(resolved);
  });

  it.each([['   '], [''], [['a', 'b']], [42]])(
    'refuses %p without asking the resolver',
    async (header) => {
      const resolver = resolverReturning(resolved);

      await expect(
        resolveUserIdentity(header, 'org_acme', resolver),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
      expect(resolver.calls).toBe(0);
    },
  );

  it('refuses an identity that names another Organization', async () => {
    await expect(
      resolveUserIdentity(
        'student-1',
        'org_acme',
        resolverReturning({ ...resolved, organizationId: 'org_other' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });
});
