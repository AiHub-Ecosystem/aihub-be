import type { Pool } from 'pg';
import { monotonicFactory } from 'ulid';

import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type {
  ApiKeyNearExpiryNotificationPayload,
  EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { isApiKeyNearExpiryNotificationPayload } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
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
const RESTORED = new Date('2026-10-22T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ORG = 'org_suspended_between';
const nextUlid = monotonicFactory();
const OWNER = `usr_${nextUlid()}`;
const ADMIN = `usr_${nextUlid()}`;
const KEY = 'key_expiring';

type TransactionOptions = NonNullable<
  Parameters<IdentityFixtureClient['$transaction']>[1]
>;

function boundValue(target: object, value: unknown): unknown {
  if (typeof value !== 'function') return value;
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(value, target, args);
    return result;
  };
}

function callValue(target: object, value: unknown, args: unknown[]): unknown {
  if (typeof value !== 'function') {
    throw new Error('expected a callable Prisma method');
  }
  const result: unknown = Reflect.apply(value, target, args);
  return result;
}

function decodeNoticePayload(
  serialized: string,
): ApiKeyNearExpiryNotificationPayload {
  const candidate: unknown = JSON.parse(serialized);
  if (!isApiKeyNearExpiryNotificationPayload(candidate)) {
    throw new Error('queued notice payload is malformed');
  }
  return candidate;
}

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
        const value: unknown = Reflect.get(target, property, target);
        if (property !== '$queryRawUnsafe' || typeof value !== 'function') {
          return boundValue(target, value);
        }
        return async (text: string, ...values: unknown[]) => {
          const rows: unknown = await callValue(target, value, [
            text,
            ...values,
          ]);
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
        const value: unknown = Reflect.get(target, property, target);
        return boundValue(target, value);
      }
      return (
        callback: (transaction: object) => Promise<unknown>,
        options?: TransactionOptions,
      ) =>
        target.$transaction(
          (transaction) => callback(wrapTransaction(transaction)),
          options,
        );
    },
  });
  return { client: paused, read, release };
}

/**
 * Holds the resolver at each statement matching `match` until the test resumes
 * it, whether the statement runs on the client or inside one of its
 * transactions. That is the gap a suspension or a restoration can commit in
 * (#996, #1128). `pause(n)` resolves once the nth matching statement has
 * parked.
 */
function pausedWhile(match: (text: string) => boolean): {
  readonly client: IdentityFixtureClient;
  readonly pause: (occurrence: number) => Promise<void>;
  readonly resume: (occurrence: number) => void;
} {
  const gates: { go: () => void }[] = [];
  const interceptStatements = <T extends object>(holder: T): T =>
    new Proxy(holder, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (
          (property === '$queryRawUnsafe' ||
            property === '$executeRawUnsafe') &&
          typeof value === 'function'
        ) {
          return async (text: string, ...values: unknown[]) => {
            if (match(text)) {
              await new Promise<void>((resolveGo) => {
                gates.push({ go: resolveGo });
              });
            }
            return callValue(target, value, [text, ...values]);
          };
        }
        if (property === '$transaction' && typeof value === 'function') {
          return (
            callback: (transaction: object) => Promise<unknown>,
            options?: TransactionOptions,
          ) =>
            callValue(target, value, [
              (transaction: object) =>
                callback(interceptStatements(transaction)),
              options,
            ]);
        }
        return boundValue(target, value);
      },
    });
  const pause = async (occurrence: number): Promise<void> => {
    for (let attempt = 0; gates.length < occurrence; attempt += 1) {
      if (attempt > 500) {
        throw new Error('the paused statement never ran');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const resume = (occurrence: number): void => {
    gates[occurrence - 1]?.go();
  };
  return {
    client: interceptStatements(client),
    pause,
    resume,
  };
}

/** What the poller does to a request whose resolver answered `undefined`. */
async function cancelNotice(id: string, at: Date): Promise<void> {
  await pool.query(
    `UPDATE email_delivery_requests
     SET status = 'cancelled', cancel_reason = 'not_actionable',
         payload_ciphertext = NULL, completed_at = $2,
         lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1`,
    [id, at],
  );
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
    payload: decodeNoticePayload(
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

describe("near-expiry notices across a restore between the resolver's reads (#1128)", () => {
  const WITHDRAWAL = (text: string) =>
    text.includes('DELETE FROM notification_events');

  it('sends the only notice instead of cancelling it when the restore commits between the recipient read and the withdrawal', async () => {
    // The single-recipient Organization: the common small-org shape where the
    // race would otherwise take the only notice there is.
    await pool.query(
      `UPDATE organization_members SET role = 'member' WHERE user_account_id = $1`,
      [ADMIN],
    );
    await sweep(noticesOver(client), NOW);
    await setOrganizationStatus('suspended');

    // The recipient read runs on the suspended snapshot and finds nobody; the
    // restoration commits before the withdrawal statement runs.
    const queued = await queuedNotices();
    const notice = queued[0];
    if (notice === undefined) {
      throw new Error('the sweep queued no notice to dispatch');
    }
    const paused = pausedWhile(WITHDRAWAL);
    const resolving = noticesOver(paused.client).resolve(notice.payload, NOW);
    await paused.pause(1);
    await setOrganizationStatus('active');
    paused.resume(1);
    const facts = await resolving;

    expect(facts).toMatchObject({
      email: `${OWNER.toLowerCase()}@example.com`,
      organizationId: ORG,
    });
    await expect(dispatch(NOW)).resolves.toBe(1);

    // The event was never withdrawn, so the later sweep re-queues nothing and
    // the recipient is not told twice.
    await sweep(noticesOver(client), LATER);
    expect(await queuedNotices()).toHaveLength(1);
    const { rows } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(rows[0]?.events).toBe(1);
  });

  it('still withdraws and re-records when the restore commits only after the withdrawal', async () => {
    await sweep(noticesOver(client), NOW);
    await setOrganizationStatus('suspended');

    // The withdrawal runs while the Organization is suspended, and the
    // restoration lands after the resolver already answered.
    await expect(dispatch(NOW)).resolves.toBe(0);
    const { rows: withdrawn } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(withdrawn[0]?.events).toBe(0);

    await setOrganizationStatus('active');
    await sweep(noticesOver(client), LATER);

    await expect(actionableNotices(LATER)).resolves.toBe(2);
  });

  it('cancels the sibling notice instead of sending twice when an earlier notice already withdrew the shared events', async () => {
    await sweep(noticesOver(client), NOW);
    await setOrganizationStatus('suspended');

    // Notice B starts on the suspended snapshot and parks before its
    // withdrawal; notice A runs to completion and withdraws the shared events.
    const queued = await queuedNotices();
    const sibling = queued[0];
    const earlier = queued[1];
    if (sibling === undefined || earlier === undefined) {
      throw new Error('the sweep queued no notices to dispatch');
    }
    const paused = pausedWhile(WITHDRAWAL);
    const resolvingSibling = noticesOver(paused.client).resolve(
      sibling.payload,
      NOW,
    );
    await paused.pause(1);
    await expect(
      noticesOver(client).resolve(earlier.payload, NOW),
    ).resolves.toBeUndefined();
    await setOrganizationStatus('active');
    paused.resume(1);

    // The events are already gone, so the sibling must not be sent now: the
    // next sweep records them again and tells every recipient exactly once.
    await expect(resolvingSibling).resolves.toBeUndefined();
    await cancelNotice(sibling.id, NOW);
    await cancelNotice(earlier.id, NOW);

    await sweep(noticesOver(client), LATER);
    expect(await queuedNotices()).toHaveLength(2);
    await expect(actionableNotices(LATER)).resolves.toBe(2);
  });

  it('hands the events back when the Organization is suspended again between the withdrawal and the re-run', async () => {
    await pool.query(
      `UPDATE organization_members SET role = 'member' WHERE user_account_id = $1`,
      [ADMIN],
    );
    await sweep(noticesOver(client), NOW);
    await setOrganizationStatus('suspended');

    // The withdrawal and the re-run park in order (the first recipient read
    // runs straight through). A restore lands before the withdrawal and a
    // second suspension lands before the re-run.
    const queued = await queuedNotices();
    const notice = queued[0];
    if (notice === undefined) {
      throw new Error('the sweep queued no notice to dispatch');
    }
    let recipientReads = 0;
    let withdrawals = 0;
    const paused = pausedWhile((text) => {
      if (WITHDRAWAL(text)) {
        withdrawals += 1;
        return withdrawals === 1;
      }
      if (text.includes('member.role IN')) {
        recipientReads += 1;
        return recipientReads > 1;
      }
      return false;
    });
    const resolving = noticesOver(paused.client).resolve(notice.payload, NOW);
    await paused.pause(1); // the withdrawal, after a read on the suspended snapshot
    await setOrganizationStatus('active');
    paused.resume(1);
    await paused.pause(2); // the re-run, about to read a re-suspended org
    await setOrganizationStatus('suspended');
    paused.resume(2);
    await expect(resolving).resolves.toBeUndefined();

    // The guard withdrew on the second suspension, so the events are back with
    // the sweep instead of stranding the dedupe key: after the next
    // restoration the only notice is queued and sent once.
    const { rows: events } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(events[0]?.events).toBe(0);
    await cancelNotice(notice.id, NOW);
    await setOrganizationStatus('active');
    await sweep(noticesOver(client), LATER);
    expect(await queuedNotices()).toHaveLength(1);
    await expect(actionableNotices(LATER)).resolves.toBe(1);
  });
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

    const { rows } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(rows[0]?.events).toBe(1);
    await expect(actionableNotices(LATER)).resolves.toBe(1);
  });
});

/** A second Organization with one owner and one expiring key of its own. */
async function seedOtherOrganization(
  organizationId: string,
  ownerId: string,
  keyId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, name, status) VALUES ($1, 'Other Org', 'active')`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [ownerId, ownerId.toLowerCase().replace('usr_', 'u-')],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, now(), now())`,
    [
      `auth_${ownerId.slice(4)}`,
      ownerId,
      `${ownerId.toLowerCase()}@example.com`,
      ARGON2ID_DUMMY_HASH,
    ],
  );
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, 'owner', 'active', now(), now())`,
    [organizationId, ownerId],
  );
  await pool.query(
    `INSERT INTO api_keys (
       id, organization_id, key_hash, key_prefix, name, status, expires_at,
       revoked_at, internal
     ) VALUES ($1, $2, sha256(convert_to($1, 'UTF8')), 'aihub_prod_x',
               'Other key', 'active', $3, NULL, false)`,
    [keyId, organizationId, new Date(NOW.getTime() + 5 * DAY)],
  );
}

describe('near-expiry notices across a withdrawal and re-record (#1098)', () => {
  it('cancels the still-queued sibling notices so a restoration tells each recipient once', async () => {
    await sweep(noticesOver(client), NOW);
    expect(await queuedNotices()).toHaveLength(2);

    // The dispatch that observes the suspension withdraws the event and, in
    // the same transaction, the sibling notice still waiting in the outbox.
    await setOrganizationStatus('suspended');
    await expect(dispatch(NOW)).resolves.toBe(0);
    expect(await queuedNotices()).toHaveLength(0);
    const { rows: events } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [KEY],
    );
    expect(events[0]?.events).toBe(0);

    // The restoration and the new sweep queue exactly one fresh notice per
    // recipient; the cancelled earlier requests never come back, so neither
    // recipient is told twice.
    await setOrganizationStatus('active');
    await sweep(noticesOver(client), RESTORED);
    expect(await queuedNotices()).toHaveLength(2);
    await expect(actionableNotices(RESTORED)).resolves.toBe(2);

    await sweep(noticesOver(client), LATER);
    expect(await queuedNotices()).toHaveLength(2);
  });

  it('leaves another Organization\u2019s queued notices alone when one is withdrawn', async () => {
    const otherOrg = 'org_unrelated';
    const otherOwner = `usr_${nextUlid()}`;
    const otherKey = 'key_other_org';
    await seedOtherOrganization(otherOrg, otherOwner, otherKey);
    await sweep(noticesOver(client), NOW);
    expect(await queuedNotices()).toHaveLength(3);

    await setOrganizationStatus('suspended');
    await expect(dispatch(NOW)).resolves.toBe(1);

    // Only the suspended Organization's notices were cancelled.
    const remaining = await queuedNotices();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.payload.organizationId).toBe(otherOrg);
    const { rows: otherEvents } = await pool.query<{ events: number }>(
      `SELECT count(*)::int AS events FROM notification_events WHERE api_key_id = $1`,
      [otherKey],
    );
    expect(otherEvents[0]?.events).toBe(1);
    await expect(actionableNotices(NOW)).resolves.toBe(1);
  });

  it('cancels a deferred sibling that no dispatch has claimed', async () => {
    await sweep(noticesOver(client), NOW);
    const queued = await queuedNotices();
    const deferred = queued[0];
    const dispatching = queued[1];
    if (deferred === undefined || dispatching === undefined) {
      throw new Error('the sweep queued no notices to dispatch');
    }

    // The poller defers a request under an outage: ownerless, its lease held
    // to the retry time, still queued. No dispatch has it.
    await pool.query(
      `UPDATE email_delivery_requests
       SET lease_owner = NULL, lease_expires_at = $2
       WHERE id = $1`,
      [deferred.id, new Date(RESTORED.getTime() + 60_000)],
    );

    await setOrganizationStatus('suspended');
    await expect(
      noticesOver(client).resolve(dispatching.payload, NOW),
    ).resolves.toBeUndefined();
    await cancelNotice(dispatching.id, NOW);

    // The deferred sibling went with the withdrawal, not just the dispatched
    // one: after the restoration, the fresh sweep is the only notice left.
    expect(await queuedNotices()).toHaveLength(0);
    await setOrganizationStatus('active');
    await sweep(noticesOver(client), RESTORED);
    expect(await queuedNotices()).toHaveLength(2);
    await expect(actionableNotices(RESTORED)).resolves.toBe(2);
  });
});
