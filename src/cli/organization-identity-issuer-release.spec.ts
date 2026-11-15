import type {
  OrganizationIdentityIssuerReleasePort,
  ReleaseOrganizationIdentityIssuerInput,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-issuer-release.port';
import {
  type OrganizationIdentityIssuerReleaseCliInput,
  runReleaseOrganizationIdentityIssuerCommand,
} from './organization-identity-issuer-release';

describe('runReleaseOrganizationIdentityIssuerCommand', () => {
  it('releases the issuer with operator request context and closes the repository', async () => {
    const calls: ReleaseOrganizationIdentityIssuerInput[] = [];
    let closed = false;
    const repository: OrganizationIdentityIssuerReleasePort & {
      close(): Promise<void>;
    } = {
      releaseIssuer: async (input) => {
        calls.push(input);
        return { kind: 'released' };
      },
      close: async () => {
        closed = true;
      },
    };
    const lines: string[] = [];

    await expect(
      runReleaseOrganizationIdentityIssuerCommand({
        databaseUrl: 'postgres://unused',
        organizationId: 'org_acme',
        actorUsername: 'aihub-ops-alice',
        repository,
        emit: (line) => lines.push(line),
        now: () => new Date('2026-09-23T10:00:00.000Z'),
      }),
    ).resolves.toBe('released');

    expect(calls[0]).toMatchObject({
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      occurredAt: new Date('2026-09-23T10:00:00.000Z'),
    });
    expect(calls[0]?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lines).toEqual(['Released the identity issuer for org_acme.']);
    expect(closed).toBe(true);
  });

  it.each([
    ['organization_not_found', 'Organization org_acme was not found.'],
    ['actor_invalid', 'aihub-ops-alice is not an active AIHUB User Account.'],
    [
      'issuer_unclaimed',
      'Organization org_acme has no claimed identity issuer.',
    ],
  ] as const)('reports %s', async (kind, message) => {
    const repository = {
      releaseIssuer: async () => ({ kind }),
      close: async () => undefined,
    } as OrganizationIdentityIssuerReleasePort & {
      close(): Promise<void>;
    };
    const lines: string[] = [];
    const input: OrganizationIdentityIssuerReleaseCliInput = {
      databaseUrl: 'postgres://unused',
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      repository,
      emit: (line) => lines.push(line),
    };

    await expect(
      runReleaseOrganizationIdentityIssuerCommand(input),
    ).resolves.toBe(kind);
    expect(lines).toEqual([message]);
  });
});
