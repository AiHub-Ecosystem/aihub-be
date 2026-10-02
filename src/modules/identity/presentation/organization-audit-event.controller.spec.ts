import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { ListOrganizationAuditEventsResponseSchema } from '@/contracts/organization/audit-event';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  type ListOrganizationAuditEventsInput,
  ORGANIZATION_AUDIT_EVENT_READ,
  type OrganizationAuditEventReadPort,
  type OrganizationAuditEventRecord,
} from '@/modules/identity/application/organization-audit-event-read.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const AUDIT_URL = `/v1/organizations/${ORGANIZATION_ID}/audit-events`;

type OrganizationStatus = 'active' | 'suspended';

function event(
  overrides: Partial<OrganizationAuditEventRecord> = {},
): OrganizationAuditEventRecord {
  return {
    id: 'oae_01J00000000000000000000001',
    action: 'api_key.revoked',
    outcome: 'applied',
    targetType: 'api_key',
    targetLabel: 'Prod backend',
    detail: { keyPrefix: 'aihub_sk_A1b2C3' },
    actorUsername: 'ada',
    requestId: 'req_01J0000000000000000000000X',
    occurredAt: new Date('2026-09-21T08:00:00.000Z'),
    ...overrides,
  };
}

describe('Organization audit trail HTTP flow', () => {
  let app: NestFastifyApplication;
  let auditEvents: jest.Mocked<OrganizationAuditEventReadPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;

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
    auditEvents = {
      listAuditEvents: jest.fn(
        async (_input: ListOrganizationAuditEventsInput) => [] as const,
      ),
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
    const userAccounts = userAccountStatus();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_AUDIT_EVENT_READ)
      .useValue(auditEvents)
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
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
    auditEvents.listAuditEvents.mockResolvedValue([]);
  });

  function read(url = AUDIT_URL) {
    return app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer valid.token.value' },
    });
  }

  function readCall(): ListOrganizationAuditEventsInput {
    const call = auditEvents.listAuditEvents.mock.calls[0];
    if (call === undefined) {
      throw new Error('listAuditEvents was not called');
    }
    return call[0];
  }

  describe('reading the trail', () => {
    it('returns the recorded acts for an owner', async () => {
      auditEvents.listAuditEvents.mockResolvedValue([event()]);

      const response = await read();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          events: [
            {
              event_id: 'oae_01J00000000000000000000001',
              action: 'api_key.revoked',
              outcome: 'applied',
              target_type: 'api_key',
              target_label: 'Prod backend',
              detail: { keyPrefix: 'aihub_sk_A1b2C3' },
              actor_username: 'ada',
              originating_request_id: 'req_01J0000000000000000000000X',
              occurred_at: '2026-09-21T08:00:00.000Z',
            },
          ],
          next_cursor: null,
        },
        meta: { request_id: REQUEST_ID },
      });
    });

    it('matches the published contract', async () => {
      auditEvents.listAuditEvents.mockResolvedValue([event()]);

      const response = await read();

      expect(
        Value.Check(ListOrganizationAuditEventsResponseSchema, response.json()),
      ).toBe(true);
    });

    it('reads the trail for an admin', async () => {
      callerRole = 'admin';

      const response = await read();

      expect(response.statusCode).toBe(200);
    });

    it('scopes the read to the organization named in the path', async () => {
      await read();

      expect(readCall().organizationId).toBe(ORGANIZATION_ID);
    });

    /**
     * What this seam can prove is that the boundary adds no identifier of its
     * own and leaks none from the caller's session. That a *stored* target
     * identifier — a User Account ID for a membership event — never escapes is
     * proven where a real row exists, in the read repository's own spec.
     */
    it('adds no user account id at the boundary', async () => {
      auditEvents.listAuditEvents.mockResolvedValue([
        event({
          action: 'membership.disabled',
          targetType: 'membership',
          targetLabel: 'grace',
          detail: {
            role: 'member',
            fromStatus: 'active',
            toStatus: 'disabled',
          },
        }),
      ]);

      const body = (await read()).body;

      expect(body).not.toContain(USER_ID);
      expect(body).not.toContain('target_id');
      expect(body).not.toContain('usr_');
    });

    /**
     * The order itself is the repository's, proven against a real engine in
     * the database lane. What matters here is that the boundary hands it
     * through untouched rather than re-sorting it into something else.
     */
    it('preserves the order the repository returned', async () => {
      const older = event({
        id: 'oae_01J00000000000000000000001',
        occurredAt: new Date('2026-09-20T08:00:00.000Z'),
      });
      const newer = event({
        id: 'oae_01J00000000000000000000002',
        occurredAt: new Date('2026-09-21T08:00:00.000Z'),
      });
      auditEvents.listAuditEvents.mockResolvedValue([newer, older]);

      const response = await read();

      expect(
        response
          .json()
          .data.events.map((entry: { event_id: string }) => entry.event_id),
      ).toEqual([newer.id, older.id]);
    });

    it('returns a redacted event with an absent label rather than hiding it', async () => {
      auditEvents.listAuditEvents.mockResolvedValue([
        event({
          action: 'invitation.sent',
          targetType: 'invitation',
          targetLabel: null,
        }),
      ]);

      const response = await read();

      expect(response.statusCode).toBe(200);
      expect(response.json().data.events).toHaveLength(1);
      expect(response.json().data.events[0].target_label).toBeNull();
    });
  });

  describe('authorization', () => {
    async function refusalBody(): Promise<string> {
      const response = await read();
      expect(response.statusCode).toBe(403);
      return response.body;
    }

    it('refuses a member', async () => {
      callerRole = 'member';

      await refusalBody();
      expect(auditEvents.listAuditEvents).not.toHaveBeenCalled();
    });

    it('refuses a disabled membership', async () => {
      callerStatus = 'disabled';

      await refusalBody();
      expect(auditEvents.listAuditEvents).not.toHaveBeenCalled();
    });

    it('refuses a caller with no membership in the named organization', async () => {
      callerMembershipExists = false;

      await refusalBody();
      expect(auditEvents.listAuditEvents).not.toHaveBeenCalled();
    });

    /**
     * The point of the single message constant: a caller must not be able to
     * tell a suspended organization from one they simply do not belong to.
     */
    it('answers every refusal identically', async () => {
      callerRole = 'member';
      const memberRefusal = await refusalBody();

      callerRole = 'owner';
      callerStatus = 'disabled';
      const disabledRefusal = await refusalBody();

      callerStatus = 'active';
      callerMembershipExists = false;
      const strangerRefusal = await refusalBody();

      expect(disabledRefusal).toBe(memberRefusal);
      expect(strangerRefusal).toBe(memberRefusal);
    });

    it('reads the trail of a suspended organization', async () => {
      organizationStatus = 'suspended';
      auditEvents.listAuditEvents.mockResolvedValue([event()]);

      const response = await read();

      expect(response.statusCode).toBe(200);
      expect(response.json().data.events).toHaveLength(1);
    });
  });

  describe('filtering', () => {
    it('filters by one action', async () => {
      await read(`${AUDIT_URL}?action=api_key.revoked`);

      expect(readCall().filter.actions).toEqual(['api_key.revoked']);
    });

    it('filters by several actions', async () => {
      await read(`${AUDIT_URL}?action=api_key.revoked&action=api_key.rotated`);

      expect(readCall().filter.actions).toEqual([
        'api_key.revoked',
        'api_key.rotated',
      ]);
    });

    it('filters by outcome', async () => {
      await read(`${AUDIT_URL}?outcome=denied`);

      expect(readCall().filter.outcome).toBe('denied');
    });

    it('filters by each window bound independently', async () => {
      await read(`${AUDIT_URL}?from=2026-09-01T00:00:00Z`);
      expect(readCall().filter).toEqual({
        from: new Date('2026-09-01T00:00:00.000Z'),
      });

      jest.clearAllMocks();
      await read(`${AUDIT_URL}?to=2026-09-30T00:00:00Z`);
      expect(readCall().filter).toEqual({
        to: new Date('2026-09-30T00:00:00.000Z'),
      });
    });

    it('filters by a half-open window', async () => {
      await read(
        `${AUDIT_URL}?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
      );

      expect(readCall().filter).toEqual({
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T00:00:00.000Z'),
      });
    });

    it('refuses an action it does not name rather than returning an empty page', async () => {
      const response = await read(`${AUDIT_URL}?action=api_key.exploded`);

      expect(response.statusCode).toBe(400);
      expect(auditEvents.listAuditEvents).not.toHaveBeenCalled();
    });

    it('refuses an outcome it does not name', async () => {
      expect((await read(`${AUDIT_URL}?outcome=maybe`)).statusCode).toBe(400);
    });

    it('refuses an inverted window', async () => {
      const response = await read(
        `${AUDIT_URL}?from=2026-09-30T00:00:00Z&to=2026-09-01T00:00:00Z`,
      );

      expect(response.statusCode).toBe(400);
    });

    it('refuses an equal window, because it is half-open and empty', async () => {
      const response = await read(
        `${AUDIT_URL}?from=2026-09-01T00:00:00Z&to=2026-09-01T00:00:00Z`,
      );

      expect(response.statusCode).toBe(400);
    });

    it('refuses a bound that is not UTC', async () => {
      expect(
        (await read(`${AUDIT_URL}?from=2026-09-01T00:00:00%2B07:00`))
          .statusCode,
      ).toBe(400);
    });

    it('refuses a date that does not exist', async () => {
      expect(
        (await read(`${AUDIT_URL}?from=2026-02-30T00:00:00Z`)).statusCode,
      ).toBe(400);
    });
  });

  describe('paging', () => {
    function page(count: number): OrganizationAuditEventRecord[] {
      return Array.from({ length: count }, (_unused, index) =>
        event({
          id: `oae_01J0000000000000000000${String(index).padStart(4, '0')}`,
          occurredAt: new Date(Date.UTC(2026, 8, 21, 8, 0, count - index)),
        }),
      );
    }

    it('defaults to fifty and asks for one beyond the page', async () => {
      await read();

      expect(readCall().limit).toBe(51);
    });

    it('honours an explicit page size', async () => {
      await read(`${AUDIT_URL}?limit=10`);

      expect(readCall().limit).toBe(11);
    });

    it('ends the trail with a null cursor', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(2));

      const response = await read(`${AUDIT_URL}?limit=10`);

      expect(response.json().data.events).toHaveLength(2);
      expect(response.json().data.next_cursor).toBeNull();
    });

    it('offers a cursor when another page follows', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(3));

      const response = await read(`${AUDIT_URL}?limit=2`);

      expect(response.json().data.events).toHaveLength(2);
      expect(typeof response.json().data.next_cursor).toBe('string');
    });

    it('resumes from the cursor it handed out', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(3));
      const cursor = (await read(`${AUDIT_URL}?limit=2`)).json().data
        .next_cursor;

      jest.clearAllMocks();
      auditEvents.listAuditEvents.mockResolvedValue([]);
      const response = await read(
        `${AUDIT_URL}?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.statusCode).toBe(200);
      const after = readCall().after;
      expect(after?.id).toBe('oae_01J00000000000000000000001');
    });

    it('returns the same page when a cursor is replayed', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(3));
      const cursor = (await read(`${AUDIT_URL}?limit=2`)).json().data
        .next_cursor;

      const url = `${AUDIT_URL}?limit=2&cursor=${encodeURIComponent(cursor)}`;
      auditEvents.listAuditEvents.mockResolvedValue(page(2));

      const first = await read(url);
      const second = await read(url);

      expect(second.body).toBe(first.body);
    });

    /**
     * The filter hash exists for this: a cursor minted under one filter must
     * not silently page through a different result set.
     */
    it('refuses a cursor whose filter changed under it', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(3));
      const cursor = (
        await read(`${AUDIT_URL}?limit=2&action=api_key.revoked`)
      ).json().data.next_cursor;

      const response = await read(
        `${AUDIT_URL}?limit=2&action=api_key.rotated&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.statusCode).toBe(400);
    });

    it('accepts a cursor when the same filters arrive in a different order', async () => {
      auditEvents.listAuditEvents.mockResolvedValue(page(3));
      const cursor = (
        await read(
          `${AUDIT_URL}?limit=2&action=api_key.revoked&action=api_key.rotated&outcome=applied`,
        )
      ).json().data.next_cursor;

      const response = await read(
        `${AUDIT_URL}?limit=2&outcome=applied&action=api_key.rotated&action=api_key.revoked&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.statusCode).toBe(200);
    });

    it('refuses a malformed cursor', async () => {
      expect((await read(`${AUDIT_URL}?cursor=not-a-cursor`)).statusCode).toBe(
        400,
      );
    });

    it('refuses a cursor carrying an unrecognized version', async () => {
      const stale = Buffer.from(
        JSON.stringify({
          v: 99,
          occurredAt: '2026-09-21T08:00:00.000Z',
          id: 'oae_01J00000000000000000000001',
          f: 'deadbeefdeadbeef',
        }),
        'utf8',
      ).toString('base64url');

      expect((await read(`${AUDIT_URL}?cursor=${stale}`)).statusCode).toBe(400);
    });

    it('refuses a page size outside the range rather than clamping it', async () => {
      expect((await read(`${AUDIT_URL}?limit=0`)).statusCode).toBe(400);
      expect((await read(`${AUDIT_URL}?limit=201`)).statusCode).toBe(400);
      expect((await read(`${AUDIT_URL}?limit=-1`)).statusCode).toBe(400);
      expect((await read(`${AUDIT_URL}?limit=ten`)).statusCode).toBe(400);
      expect(auditEvents.listAuditEvents).not.toHaveBeenCalled();
    });
  });
});
