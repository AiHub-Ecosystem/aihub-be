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
const LATER = new Date('2026-10-23T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ORG = 'org_suspended_between';
const nextUlid = monotonicFactory();
const OWNER = `usr_${nextUlid()}`;
const ADMIN = `usr_${nextUlid()}`;
const KEY = 'key_expiring';

let pool: Pool;
let client: IdentityFixtureClient;
let cipher: EmailPayloadCipherPort;

function noticesOver(
  over: IdentityFixtureClient,
): PostgresApiKeyNearExpiryNotices {
  return new PostgresApiKeyNearExpiryNotices(
    over,
    cipher,
    new PostgresEmailDeliveryRequestRepository(),
  );
}

/**
 * The sweep's own transaction, held after it read the due keys and before it
 * wrote anything, until the test releases it. That is the gap a suspension
 * can commit in.
 */
function pausedAfterRead(): {
  readonly client: IdentityFixtureClient;
  readonly read: Promise<void>;
  readonly release: () => void;
} {
  let signalRead = () => {};
  const read = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapTransaction = (transaction: object) =>
    new Proxy(transaction, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== '$queryRawUnsafe' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (text: string, ...values: unknown[]) => {
          const rows = await value.call(target, text, ...values);
          if (text.includes('FROM api_keys AS api_key')) {
            signalRead();
            await released;
          }
          return rows;
        };
      },
    });
  const paused = new Proxy(client, {
    get(target, property) {
      if (property !== '$transaction') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (
        callback: (transaction: object) => Promise<unknown>,
        options?: unknown,
      ) =>
        target.$transaction(
          (transaction) => callback(wrapTransaction(transaction)),
          options as never,
        );
    },
  });
  return { client: paused, read, release };
}

function sweep(notices: PostgresApiKeyNearExpiryNotices, now: Date) {
  return notices.recordDue({
    now,
    windowEnd: new Date(now.getTime() + 14 * DAY),
    newEventId: prefixedIdGenerator('nev_'),
    newEmailDeliveryId: prefixedIdGenerator('edr_'),
  });
}

async function setOrganizationStatus(status: string): Promise<void> {
  await pool.query('UPDATE organizations SET status = $2 WHERE id = $1', [
    ORG,
    status,
  ]);
}

async function queuedNotices(): Promise<
  readonly {
    readonly id: string;
    readonly payload: ApiKeyNearExpiryNotificationPayload;
  }[]
> {
  const result = await pool.query<{ id: string; payload: string }>(
    `SELECT id, payload_ciphertext AS payload FROM email_delivery_requests
     WHERE status = 'queued' AND kind = 'api_key_near_expiry_notification'`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    payload: JSON.parse(
      cipher.decrypt(row.payload, {
        id: row.id,
        kind: 'api_key_near_expiry_notification',
      }),
    ),
  }));
}

/** What dispatch does: read the facts again and cancel what is not actionable. */
async function dispatch(now: Date): Promise<number> {
  const notices = noticesOver(client);
  let actionable = 0;
  for (const notice of await queuedNotices()) {
    const facts = await notices.resolve(notice.payload, now);
    if (facts === undefined) {
      await pool.query(
        `UPDATE email_delivery_requests
         SET status = 'cancelled', cancel_reason = 'not_actionable',
             payload_ciphertext = NULL, completed_at = $2,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1`,
        [notice.id, now],
      );
    } else {
      actionable += 1;
    }
  }
  return actionable;
}

async function actionableNotices(now: Date): Promise<number> {
  const notices = noticesOver(client);
  let count = 0;
  for (const notice of await queuedNotices()) {
    if ((await notices.resolve(notice.payload, now)) !== undefined) count += 1;
  }
  return count;
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(testDatabaseUrl());
  cipher = createEmailPayloadCipher(
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox,
  );
});

afterAll(async () => {
  await client?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query(
    `INSERT INTO organizations (id, name, status) VALUES ($1, 'Suspended Between', 'active')`,
    [ORG],
  );
  for (const [id, role] of [
    [OWNER, 'owner'],
    [ADMIN, 'admin'],
  ] as const) {
    await pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [id, id.toLowerCase().replace('usr_', 'u-')],
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
    await pool.query(
      `INSERT INTO organization_members (
         organization_id, user_account_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', now(), now())`,
      [ORG, id, role],
    );
  }
  await pool.query(
    `INSERT INTO api_keys (
       id, organization_id, key_hash, key_prefix, name, status, expires_at,
       revoked_at, internal
     ) VALUES ($1, $2, sha256(convert_to($1, 'UTF8')), 'aihub_prod_x',
               'Expiring key', 'active', $3, NULL, false)`,
    [KEY, ORG, new Date(NOW.getTime() + 5 * DAY)],
  );
});

describe('near-expiry notices across an Organization suspension (#996)', () => {
  it('notifies once after restoration when the suspension commits between the sweep reading and recording', async () => {
    // 1. The sweep reads the key while the Organization is still active.
    const paused = pausedAfterRead();
    const running = sweep(noticesOver(paused.client), NOW);
    await paused.read;
    // 2. The suspension commits.
    await setOrganizationStatus('suspended');
    // 3. The sweep commits the event and its email from its earlier read.
    paused.release();
    await running;
    expect(await queuedNotices()).toHaveLength(2);

    // 4. Dispatch finds nothing actionable while the Organization is suspended.
    await expect(dispatch(NOW)).resolves.toBe(0);

    // 5. The Organization is restored inside the window.
    await setOrganizationStatus('active');
    // 6. The next sweep runs while the key is still inside the window.
    await sweep(noticesOver(client), LATER);

    await expect(actionableNotices(LATER)).resolves.toBe(2);
    expect(
      (await queuedNotices())
        .map((notice) => notice.payload.userAccountId)
        .sort(),
    ).toEqual([ADMIN, OWNER].sort());
  });

  it('notifies once after restoration when the suspension commits after the sweep and before dispatch', async () => {
    await sweep(noticesOver(client), NOW);
    await setOrganizationStatus('suspended');

    await expect(dispatch(NOW)).resolves.toBe(0);

    await setOrganizationStatus('active');
    await sweep(noticesOver(client), LATER);

    await expect(actionableNotices(LATER)).resolves.toBe(2);
  });

  it('keeps the event when a notice is not actionable for another reason, so nothing is sent twice', async () => {
    await sweep(noticesOver(client), NOW);
    await pool.query(
      `UPDATE organization_members SET role = 'member' WHERE user_account_id = $1`,
      [ADMIN],
    );

    await expect(dispatch(NOW)).resolves.toBe(1);
    await sweep(noticesOver(client), LATER);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(rows[0]?.events).toBe(1);
    await expect(actionableNotices(LATER)).resolves.toBe(1);
  });
});
