import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
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
  ORGANIZATION_READ_ADMISSION,
  type OrganizationReadSurface,
} from '../application/organization-admission';
import {
  type ListOrganizationAuditEventsInput,
  ORGANIZATION_AUDIT_EVENT_READ,
  type OrganizationAuditEventReadPort,
} from '../application/organization-audit-event-read.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from '../application/organization-identity-config-repository.port';
import {
  type ListOpenOrganizationInvitationsInput,
  ORGANIZATION_INVITATION,
  type OpenOrganizationInvitationRecord,
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

type OrganizationStatus = 'active' | 'suspended';

const ROUTES: Readonly<Record<OrganizationReadSurface, string>> = {
  membership_list: `/v1/organizations/${ORGANIZATION_ID}/members`,
  open_invitations: `/v1/organizations/${ORGANIZATION_ID}/invitations`,
  audit_read: `/v1/organizations/${ORGANIZATION_ID}/audit-events`,
  identity_configuration: `/v1/organizations/${ORGANIZATION_ID}/identity-config`,
};

/** The three surfaces whose admission settles in the application tier. */
const APPLICATION_TIER: readonly OrganizationReadSurface[] = [
  'open_invitations',
  'audit_read',
  'identity_configuration',
];

type CallerKind =
  | 'owner of an active Organization'
  | 'admin of an active Organization'
  | 'member of an active Organization'
  | 'a disabled membership'
  | 'a caller outside the Organization'
  | 'an owner of a suspended Organization'
  | 'an admin of a suspended Organization';

function arrangeCaller(kind: CallerKind): {
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  exists: boolean;
  organizationStatus: OrganizationStatus;
} {
  switch (kind) {
    case 'owner of an active Organization':
      return {
        role: 'owner',
        status: 'active',
        exists: true,
        organizationStatus: 'active',
      };
    case 'admin of an active Organization':
      return {
        role: 'admin',
        status: 'active',
        exists: true,
        organizationStatus: 'active',
      };
    case 'member of an active Organization':
      return {
        role: 'member',
        status: 'active',
        exists: true,
        organizationStatus: 'active',
      };
    case 'a disabled membership':
      return {
        role: 'owner',
        status: 'disabled',
        exists: true,
        organizationStatus: 'active',
      };
    case 'a caller outside the Organization':
      return {
        role: 'owner',
        status: 'active',
        exists: false,
        organizationStatus: 'active',
      };
    case 'an owner of a suspended Organization':
      return {
        role: 'owner',
        status: 'active',
        exists: true,
        organizationStatus: 'suspended',
      };
    case 'an admin of a suspended Organization':
      return {
        role: 'admin',
        status: 'active',
        exists: true,
        organizationStatus: 'suspended',
      };
  }
}

const CALLER_KINDS: readonly CallerKind[] = [
  'owner of an active Organization',
  'admin of an active Organization',
  'member of an active Organization',
  'a disabled membership',
  'a caller outside the Organization',
  'an owner of a suspended Organization',
  'an admin of a suspended Organization',
];

const EXPECTED: Readonly<
  Record<
    OrganizationReadSurface,
    Readonly<Record<CallerKind, 'read' | 'refused'>>
  >
> = {
  // Not driven through the application tier: its admission settles inside its
  // own query under ADR-0051, and the database lane is where it is covered.
  membership_list: {
    'owner of an active Organization': 'read',
    'admin of an active Organization': 'read',
    'member of an active Organization': 'refused',
    'a disabled membership': 'refused',
    'a caller outside the Organization': 'refused',
    'an owner of a suspended Organization': 'refused',
    'an admin of a suspended Organization': 'refused',
  },
  open_invitations: {
    'owner of an active Organization': 'read',
    'admin of an active Organization': 'read',
    'member of an active Organization': 'refused',
    'a disabled membership': 'refused',
    'a caller outside the Organization': 'refused',
    'an owner of a suspended Organization': 'refused',
    'an admin of a suspended Organization': 'refused',
  },
  audit_read: {
    'owner of an active Organization': 'read',
    'admin of an active Organization': 'read',
    'member of an active Organization': 'refused',
    'a disabled membership': 'refused',
    'a caller outside the Organization': 'refused',
    // ADR-0040: the trail is evidence, and a suspended Organization's owner is
    // the one who needs it.
    'an owner of a suspended Organization': 'read',
    'an admin of a suspended Organization': 'read',
  },
  identity_configuration: {
    'owner of an active Organization': 'read',
    // ADR-0055: an admin manages membership and API keys, but does not hold
    // the Organization's assertion trust anchor.
    'admin of an active Organization': 'refused',
    'member of an active Organization': 'refused',
    'a disabled membership': 'refused',
    'a caller outside the Organization': 'refused',
    'an owner of a suspended Organization': 'refused',
    'an admin of a suspended Organization': 'refused',
  },
};

/**
 * Every surface's refusal text, written out by hand and never read from the
 * policy table. A string edited in the table has to be edited here too, which
 * is the point: the published wording is pinned, not derived.
 */
const PUBLISHED_REFUSALS: Readonly<Record<OrganizationReadSurface, string>> = {
  membership_list: 'Organization membership list access is forbidden',
  open_invitations: 'Organization invitation access is forbidden',
  audit_read: 'Organization audit access is forbidden',
  identity_configuration:
    'Organization identity configuration access is forbidden',
};

describe('Organization read admission through the public route', () => {
  let app: NestFastifyApplication;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let invitations: jest.Mocked<OrganizationInvitationPort>;
  let auditEvents: jest.Mocked<OrganizationAuditEventReadPort>;
  let identityConfigs: jest.Mocked<OrganizationIdentityConfigRepositoryPort>;

  let caller: ReturnType<typeof arrangeCaller> = arrangeCaller(
    'owner of an active Organization',
  );

  beforeAll(async () => {
    membership = {
      resolveMembership: jest.fn(async ({ organizationId, userId }) => {
        if (!caller.exists) {
          return { kind: 'missing' as const };
        }
        const record = {
          organizationId,
          userId,
          organizationStatus: caller.organizationStatus,
          role: caller.role,
          status: caller.status,
        };
        return caller.status === 'active'
          ? { kind: 'active' as const, membership: record }
          : { kind: 'disabled' as const, membership: record };
      }),
      listRoster: jest.fn(async (_input: ListRosterInput) => []),
      changeRole: jest.fn(),
      disable: jest.fn(),
      transfer: jest.fn(),
    };
    invitations = {
      listOpenInvitations: jest.fn(
        async (_input: ListOpenOrganizationInvitationsInput) => [],
      ),
      createInvitation: jest.fn(),
      revokeInvitation: jest.fn(),
      acceptInvitation: jest.fn(),
    };
    auditEvents = {
      listAuditEvents: jest.fn(
        async (_input: ListOrganizationAuditEventsInput) => [],
      ),
    };
    identityConfigs = {
      findByOrganizationId: jest.fn(async (_organizationId: string) => null),
      findActiveByOrganizationId: jest.fn(
        async (_organizationId: string) => null,
      ),
      saveForOwner: jest.fn(),
    };

    const tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort> = {
      issue: jest.fn(async (_userId: string) => ({
        token: 'reissued.token.value',
        expiresIn: 900,
      })),
    };
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
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
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(ORGANIZATION_INVITATION)
      .useValue(invitations)
      .overrideProvider(ORGANIZATION_AUDIT_EVENT_READ)
      .useValue(auditEvents)
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue(identityConfigs)
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
    caller = arrangeCaller('owner of an active Organization');
    jest.clearAllMocks();
    invitations.listOpenInvitations.mockResolvedValue([]);
    auditEvents.listAuditEvents.mockResolvedValue([]);
    identityConfigs.findByOrganizationId.mockResolvedValue(null);
  });

  function read(surface: OrganizationReadSurface) {
    return app.inject({
      method: 'GET',
      url: ROUTES[surface],
      headers: { authorization: 'Bearer valid.token.value' },
    });
  }

  // One table for the three application-tier reads, so proving a refusal is a
  // single act rather than one per use case.
  it.each(
    APPLICATION_TIER.flatMap((surface) =>
      CALLER_KINDS.map((kind) => [surface, kind] as const),
    ),
  )('%s answers %s the same way on every caller', async (surface, kind) => {
    caller = arrangeCaller(kind);

    const response = await read(surface);
    const expectedRead = EXPECTED[surface][kind] === 'read';

    // One literal per surface for every refusal, so no two refusals on the
    // same surface can differ by status, code, or message.
    const expected = expectedRead
      ? 200
      : {
          status: 403,
          body: {
            error: {
              code: 'FORBIDDEN',
              message: PUBLISHED_REFUSALS[surface],
              request_id: REQUEST_ID,
              retryable: false,
            },
          },
        };

    expect(
      expectedRead
        ? response.statusCode
        : { status: response.statusCode, body: response.json() },
    ).toEqual(expected);
  });

  it('projects an open invitation as actionable, keeping the pending status public', async () => {
    const createdAt = new Date('2026-09-21T11:00:00.000Z');
    const expiresAt = new Date('2026-09-22T11:00:00.000Z');
    const stored: OpenOrganizationInvitationRecord = {
      invitationId: 'oiv_01J00000000000000000000000',
      email: 'invitee@example.com',
      role: 'member',
      invitedByUsername: 'ada',
      createdAt,
      expiresAt,
    };
    invitations.listOpenInvitations.mockResolvedValue([stored]);
    caller = arrangeCaller('owner of an active Organization');

    const response = await read('open_invitations');

    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: {
        data: {
          invitations: [
            {
              invitation_id: 'oiv_01J00000000000000000000000',
              email: 'invitee@example.com',
              role: 'member',
              invited_by_username: 'ada',
              created_at: createdAt.toISOString(),
              expires_at: expiresAt.toISOString(),
              status: 'pending',
            },
          ],
        },
        meta: { request_id: REQUEST_ID },
      },
    });
  });

  it('reads the store only when the caller is admitted', async () => {
    caller = arrangeCaller('a caller outside the Organization');
    await read('open_invitations');
    const refusedInvitations =
      invitations.listOpenInvitations.mock.calls.length;

    await read('audit_read');
    const refusedAudit = auditEvents.listAuditEvents.mock.calls.length;

    await read('identity_configuration');
    const refusedConfigs =
      identityConfigs.findByOrganizationId.mock.calls.length;

    caller = arrangeCaller('owner of an active Organization');
    await read('open_invitations');
    await read('audit_read');
    await read('identity_configuration');

    expect([
      invitations.listOpenInvitations.mock.calls.length - refusedInvitations,
      auditEvents.listAuditEvents.mock.calls.length - refusedAudit,
      identityConfigs.findByOrganizationId.mock.calls.length - refusedConfigs,
    ]).toEqual([1, 1, 1]);
  });

  // The table above is written by hand on purpose. This is what keeps it
  // honest: if the policy table and the hand-written matrix ever disagree, one
  // of the two suites fails instead of the pair drifting apart unnoticed.
  it('agrees with the shared policy table on every surface and caller', () => {
    for (const surface of Object.keys(EXPECTED) as OrganizationReadSurface[]) {
      const rule = ORGANIZATION_READ_ADMISSION[surface];

      for (const kind of CALLER_KINDS) {
        const arrangement = arrangeCaller(kind);
        const admitsRole = rule.admittedRoles.includes(arrangement.role);
        const suspensionAllows =
          !rule.suspensionClosesSurface ||
          arrangement.organizationStatus === 'active';
        // A disabled or absent membership never reaches either check.
        const expectedOutcome =
          arrangement.exists &&
          arrangement.status === 'active' &&
          admitsRole &&
          suspensionAllows
            ? 'read'
            : 'refused';

        expect({
          surface,
          kind,
          outcome: EXPECTED[surface][kind],
        }).toEqual({ surface, kind, outcome: expectedOutcome });
      }
    }
  });

  // The published wording is pinned here rather than read from the table, so
  // editing a refusal string in the table fails the build instead of quietly
  // changing what every caller is told.
  it('publishes exactly the refusal text each surface has always returned', () => {
    for (const surface of Object.keys(
      PUBLISHED_REFUSALS,
    ) as OrganizationReadSurface[]) {
      expect({
        surface,
        refusal: ORGANIZATION_READ_ADMISSION[surface].refusal,
      }).toEqual({
        surface,
        refusal: PUBLISHED_REFUSALS[surface],
      });
    }
  });
});
