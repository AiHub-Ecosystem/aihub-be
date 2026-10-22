import type { Pool } from 'pg';
import { monotonicFactory } from 'ulid';

import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type {
  ApiKeyNearExpiryNotificationPayload,
  EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { createEmailPayloadCipher } from '@/modules/auth/email-delivery/infrastructure/email-payload-cipher';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { PostgresApiKeyNearExpiryNotices } from '@/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices';
import {
  type IdentityFixtureClient,
  createPostgresIdentityClient,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ORG = 'org_resonance';

// Minted in this order so the ids sort the way the names read.
const nextUlid = monotonicFactory();
const USER = {
  admin: `usr_${nextUlid()}`,
  member: `usr_${nextUlid()}`,
  owner: `usr_${nextUlid()}`,
  removedAdmin: `usr_${nextUlid()}`,
  disabledOwner: `usr_${nextUlid()}`,
} as const;

let pool: Pool;
let client: IdentityFixtureClient;
let cipher: EmailPayloadCipherPort;
let notices: PostgresApiKeyNearExpiryNotices;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(testDatabaseUrl());
  cipher = createEmailPayloadCipher(
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox,
  );
  notices = new PostgresApiKeyNearExpiryNotices(
    client,
    cipher,
    new PostgresEmailDeliveryRequestRepository(),
  );
});

afterAll(async () => {
  await client?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

async function organization(id: string, status = 'active'): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)`,
    [id, `Name of ${id}`, status],
  );
}

async function person(
  id: string,
  options: { readonly accountStatus?: string } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [
      id,
      id.toLowerCase().replace('usr_', 'u-'),
      options.accountStatus ?? 'active',
    ],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, now(), now())`,
    [
      `auth_${id.slice(4)}`,
      id,
      `${id.toLowerCase()}@example.com`,
      ARGON2ID_DUMMY_HASH,
    ],
  );
}

async function member(
  organizationId: string,
  userAccountId: string,
  role: string,
  status = 'active',
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, now(), now())`,
    [organizationId, userAccountId, role, status],
  );
}

async function key(
  id: string,
  options: {
    readonly organizationId?: string;
    readonly expiresInDays: number | null;
    readonly status?: string;
    readonly internal?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO api_keys (
       id, organization_id, key_hash, key_prefix, name, status, expires_at,
       revoked_at, internal
     ) VALUES ($1, $2, sha256(convert_to($1, 'UTF8')), 'aihub_prod_x', $3,
               $4, $5, $6, $7)`,
    [
      id,
      options.organizationId ?? ORG,
      `Key ${id}`,
      options.status ?? 'active',
      options.expiresInDays === null
        ? null
        : new Date(NOW.getTime() + options.expiresInDays * DAY),
      options.status === 'revoked' ? NOW : null,
      options.internal ?? false,
    ],
  );
}

function sweep(now = NOW) {
  return notices.recordDue({
    now,
    windowEnd: new Date(now.getTime() + 14 * DAY),
    newEventId: prefixedIdGenerator('nev_'),
    newEmailDeliveryId: prefixedIdGenerator('edr_'),
  });
}

async function events(): Promise<readonly string[]> {
  const result = await pool.query<{ api_key_id: string }>(
    `SELECT api_key_id FROM notification_events
     WHERE kind = 'api-key.near-expiry' ORDER BY api_key_id`,
  );
  return result.rows.map((row) => row.api_key_id);
}

async function queuedNotices(): Promise<
  readonly ApiKeyNearExpiryNotificationPayload[]
> {
  const result = await pool.query<{ kind: string; payload: string }>(
    `SELECT kind, payload_ciphertext AS payload FROM email_delivery_requests
     WHERE status = 'queued'`,
  );
  return result.rows
    .map((row) => {
      expect(row.kind).toBe('api_key_near_expiry_notification');
      return JSON.parse(
        cipher.decrypt(row.payload),
      ) as ApiKeyNearExpiryNotificationPayload;
    })
    .sort((left, right) =>
      left.userAccountId.localeCompare(right.userAccountId),
    );
}

async function seedTypicalOrganization(): Promise<void> {
  await organization(ORG);
  for (const id of [USER.admin, USER.member, USER.owner, USER.removedAdmin]) {
    await person(id);
  }
  await person(USER.disabledOwner, { accountStatus: 'disabled' });
  await member(ORG, USER.owner, 'owner');
  await member(ORG, USER.admin, 'admin');
  await member(ORG, USER.member, 'member');
  await member(ORG, USER.removedAdmin, 'admin', 'disabled');
  await member(ORG, USER.disabledOwner, 'owner');
}

describe('API key near-expiry sweep', () => {
  it('records each key in the window once and queues one notice per owner or admin', async () => {
    await seedTypicalOrganization();
    await key('key_soon', { expiresInDays: 3 });
    await key('key_later', { expiresInDays: 10 });
    await key('key_outside', { expiresInDays: 20 });
    await key('key_forever', { expiresInDays: null });
    await key('key_internal', { expiresInDays: 3, internal: true });
    await key('key_revoked', { expiresInDays: 3, status: 'revoked' });
    await key('key_expired', { expiresInDays: -1 });

    const summary = await sweep();

    expect(await events()).toEqual(['key_later', 'key_soon']);
    expect(await queuedNotices()).toEqual([
      {
        organizationId: ORG,
        userAccountId: USER.admin,
        apiKeyIds: ['key_later', 'key_soon'],
      },
      {
        organizationId: ORG,
        userAccountId: USER.owner,
        apiKeyIds: ['key_later', 'key_soon'],
      },
    ]);
    expect(summary).toEqual({
      eventsRecorded: 2,
      emailsQueued: 2,
      keysSkipped: 0,
    });
  });

  it('records and queues nothing when no key is in the window', async () => {
    await seedTypicalOrganization();
    await key('key_outside', { expiresInDays: 20 });

    expect(await sweep()).toEqual({
      eventsRecorded: 0,
      emailsQueued: 0,
      keysSkipped: 0,
    });
    expect(await events()).toEqual([]);
  });

  it('queues no notice for an admin with no email to send it to', async () => {
    await seedTypicalOrganization();
    await pool.query(`DELETE FROM auth_identities WHERE user_account_id = $1`, [
      USER.admin,
    ]);
    await key('key_soon', { expiresInDays: 3 });

    const summary = await sweep();

    expect(summary.emailsQueued).toBe(1);
    expect(
      (await queuedNotices()).map((notice) => notice.userAccountId),
    ).toEqual([USER.owner]);
  });

  it('records nothing for a suspended Organization', async () => {
    await organization(ORG, 'suspended');
    await person(USER.owner);
    await member(ORG, USER.owner, 'owner');
    await key('key_soon', { expiresInDays: 3 });

    const summary = await sweep();

    expect(await events()).toEqual([]);
    expect(await queuedNotices()).toEqual([]);
    expect(summary.eventsRecorded).toBe(0);
  });

  it('queues nothing new when it runs again, and catches up a key that entered the window', async () => {
    await seedTypicalOrganization();
    await key('key_soon', { expiresInDays: 3 });
    await key('key_next', { expiresInDays: 15 });
    await sweep();

    const nextDay = await sweep(new Date(NOW.getTime() + 2 * DAY));

    expect(await events()).toEqual(['key_next', 'key_soon']);
    expect(nextDay).toEqual({
      eventsRecorded: 1,
      emailsQueued: 2,
      keysSkipped: 1,
    });
    expect(
      (await queuedNotices())
        .map((notice) => `${notice.userAccountId}:${notice.apiKeyIds.join()}`)
        .sort(),
    ).toEqual([
      `${USER.admin}:key_next`,
      `${USER.admin}:key_soon`,
      `${USER.owner}:key_next`,
      `${USER.owner}:key_soon`,
    ]);
  });

  it('queues one notice per recipient when two sweeps race', async () => {
    await seedTypicalOrganization();
    await key('key_soon', { expiresInDays: 3 });

    await Promise.all([sweep(), sweep()]);

    expect(await events()).toEqual(['key_soon']);
    expect(await queuedNotices()).toHaveLength(2);
  });
});

describe('API key near-expiry notice resolution', () => {
  const payload: ApiKeyNearExpiryNotificationPayload = {
    organizationId: ORG,
    userAccountId: USER.owner,
    apiKeyIds: ['key_a', 'key_b'],
  };

  beforeEach(async () => {
    await seedTypicalOrganization();
    await key('key_a', { expiresInDays: 3 });
    await key('key_b', { expiresInDays: 5 });
  });

  it('answers with the recipient, the Organization, and the keys still active', async () => {
    await pool.query(
      `UPDATE api_keys SET status = 'revoked', revoked_at = $1 WHERE id = 'key_a'`,
      [NOW],
    );
    await pool.query(`UPDATE api_keys SET name = 'Renamed' WHERE id = 'key_b'`);

    expect(await notices.resolve(payload, NOW)).toEqual({
      email: `${USER.owner.toLowerCase()}@example.com`,
      organizationId: ORG,
      organizationName: `Name of ${ORG}`,
      apiKeys: [
        {
          id: 'key_b',
          name: 'Renamed',
          expiresAt: new Date(NOW.getTime() + 5 * DAY),
        },
      ],
    });
  });

  it('finds nothing to tell once every listed key has expired', async () => {
    expect(
      await notices.resolve(payload, new Date(NOW.getTime() + 6 * DAY)),
    ).toBeUndefined();
  });

  it('finds nothing to tell a recipient who is no longer an owner or admin', async () => {
    await pool.query(
      `UPDATE organization_members SET role = 'member'
       WHERE user_account_id = $1`,
      [USER.owner],
    );

    expect(await notices.resolve(payload, NOW)).toBeUndefined();
  });

  it('finds nothing to tell about a suspended Organization', async () => {
    await pool.query(`UPDATE organizations SET status = 'suspended'`);

    expect(await notices.resolve(payload, NOW)).toBeUndefined();
  });
});
