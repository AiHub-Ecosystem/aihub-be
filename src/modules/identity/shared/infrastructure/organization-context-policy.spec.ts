import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { isOrganizationContextAllowed } from './organization-context-policy';

function context(organizationId?: string): RequestContext {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: new Date('2026-09-21T00:00:00.000Z'),
    deadlineMs: 5_000,
    userId: 'usr_actor',
    ...(organizationId === undefined ? {} : { organizationId }),
    scopes: [],
  });
}

const matching = context('org_acme');

/**
 * The three policies are the whole decision an Organization-scoped repository
 * makes before it opens a connection: which Organization the call is about, and
 * whether the caller was expected to name one. Every repository entry point
 * delegates here, so this is the one place where all fourteen of them are
 * pinned at once.
 */
describe('isOrganizationContextAllowed', () => {
  describe('required', () => {
    const policy = { kind: 'required', organizationId: 'org_acme' } as const;

    it('allows a context naming the Organization the call is about', () => {
      expect(isOrganizationContextAllowed(matching, policy)).toBe(true);
    });

    it('refuses a context naming another Organization', () => {
      expect(isOrganizationContextAllowed(context('org_other'), policy)).toBe(
        false,
      );
    });

    // A required policy that tolerated an absent context would let an
    // unscoped call through the repositories that declare one.
    it('refuses a context with no Organization at all', () => {
      expect(isOrganizationContextAllowed(context(), policy)).toBe(false);
    });
  });

  describe('optional', () => {
    const policy = { kind: 'optional', organizationId: 'org_acme' } as const;

    it('allows a context naming the Organization the call is about', () => {
      expect(isOrganizationContextAllowed(matching, policy)).toBe(true);
    });

    // This is the distinction that has to read as deliberate: tolerating an
    // absent context is not the same as tolerating a different one.
    it('allows a context with no Organization', () => {
      expect(isOrganizationContextAllowed(context(), policy)).toBe(true);
    });

    it('still refuses a context naming another Organization', () => {
      expect(isOrganizationContextAllowed(context('org_other'), policy)).toBe(
        false,
      );
    });
  });

  describe('forbidden', () => {
    const policy = { kind: 'forbidden' } as const;

    it('allows a context with no Organization', () => {
      expect(isOrganizationContextAllowed(context(), policy)).toBe(true);
    });

    it('refuses a context naming any Organization, including the one the call is about', () => {
      expect(isOrganizationContextAllowed(matching, policy)).toBe(false);
      expect(isOrganizationContextAllowed(context('org_other'), policy)).toBe(
        false,
      );
    });
  });
});
