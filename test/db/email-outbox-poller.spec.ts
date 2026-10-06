import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { getMetrics } from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/application/email-delivery-poller';
import type {
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailPayloadCipherPort,
} from '@/modules/auth/application/email-delivery-request.port';
import type {
  EmailDispatchOptions,
  EmailSenderPort,
} from '@/modules/auth/application/email-sender.port';
import { reportTerminalEmailDeliveryFailure } from '@/modules/auth/infrastructure/email-outbox-poller.scheduler';
import { createEmailPayloadCipher } from '@/modules/auth/infrastructure/email-payload-cipher';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from '@/modules/auth/infrastructure/postgres-auth.client';
import { PostgresEmailCredentialRepository } from '@/modules/auth/infrastructure/postgres-email-credential.repository';
import { PostgresEmailDispatchStore } from '@/modules/auth/infrastructure/postgres-email-delivery-request.repository';
import { createRuntimeSecretProviderFromProcessEnvironment } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const OWNER_A = 'outbox-instance-a';
const OWNER_B = 'outbox-instance-b';

/**
 * The cipher the application itself uses, so a row written here can only be read
 * back by a poller holding the same key: the production shape, not a stub.
 */
const cipher = createEmailPayloadCipher(
  createRuntimeSecretProviderFromProcessEnvironment().getSnapshot().emailOutbox,
);

/**
 * A keyring this instance does not hold, standing in for the instance that sealed
 * a row after a rotation the reader has not restarted through.
 */
const foreignCipher = createEmailPayloadCipher({
  currentKeyId: 'unseen-2026-11',
  keys: { 'unseen-2026-11': randomBytes(32).toString('base64') },
});

const MINUTE = 60_000;

/** sha256 hex, the one shape all three credential tables store. */
function hash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

let pool: Pool;
let client: PostgresAuthClient;
let store: PostgresEmailDispatchStore;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  store = new PostgresEmailDispatchStore(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

interface SeededRequest {
  readonly id: string;
  readonly tokenHash: string;
  /** The plaintext a provider would have received, kept so tests can prove it is absent. */
  readonly email: string;
  readonly token: string;
}

interface SeedOptions {
  readonly kind?: EmailDeliveryKind;
  readonly expiresAt?: Date;
  readonly organizationName?: string;
  readonly role?: 'owner' | 'admin' | 'member';
  /** Seals the payload with another keyring, as a rotation leaves rows sealed. */
  readonly sealedWith?: EmailPayloadCipherPort;
}

/**
 * One credential row and the Email Delivery Request that carries its raw token,
 * which is the pairing the two writers commit in a single transaction.
 */
async function seedRequest(options: SeedOptions = {}): Promise<SeededRequest> {
  const kind = options.kind ?? 'verification_email';
  const token = `raw-token-${ulid()}`;
  const tokenHash = hash(token);
  const expiresAt = options.expiresAt ?? new Date(NOW.getTime() + HOUR);
  const email = `person-${ulid()}@example.com`;
  const userId = `usr_${ulid()}`;
  const organizationId = `org_${ulid()}`;

  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [userId, `user-${userId.slice(4, 16).toLowerCase()}`, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [
      `auth_${ulid()}`,
      userId,
      email,
      '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA',
      NOW,
    ],
  );
  await pool.query(
    'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
    [organizationId, `Organization ${organizationId}`, 'active'],
  );

  if (kind === 'verification_email') {
    await pool.query(
      `INSERT INTO email_verification_tokens (
         id, user_account_id, token_hash, expires_at, consumed_at, created_at
       ) VALUES ($1, $2, $3, $4, NULL, $5)`,
      [`evt_${ulid()}`, userId, tokenHash, expiresAt, NOW],
    );
  } else if (kind === 'password_reset_email') {
    await pool.query(
      `INSERT INTO password_reset_tokens (
         id, user_account_id, token_hash, expires_at, consumed_at, created_at
       ) VALUES ($1, $2, $3, $4, NULL, $5)`,
      [`prt_${ulid()}`, userId, tokenHash, expiresAt, NOW],
    );
  } else {
    await pool.query(
      `INSERT INTO organization_invitations (
         id, organization_id, email, role, invited_by, token_hash,
         expires_at, consumed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
      [
        `oiv_${ulid()}`,
        organizationId,
        email,
        options.role ?? 'member',
        userId,
        tokenHash,
        expiresAt,
        NOW,
      ],
    );
  }

  const id = `edr_${ulid()}`;
  const shared = {
    email,
    token,
    expiresAt: expiresAt.toISOString(),
  };
  const payload =
    kind === 'organization_invite_email'
      ? {
          ...shared,
          organizationName: options.organizationName ?? 'Resonance',
          role: options.role ?? 'member',
        }
      : shared;
  await pool.query(
    `INSERT INTO email_delivery_requests (
       id, kind, status, payload_ciphertext, attempts, last_attempt_at, created_at
     ) VALUES ($1, $2, 'queued', $3, 0, NULL, $4)`,
    [
      id,
      kind,
      (options.sealedWith ?? cipher).encrypt(JSON.stringify(payload)),
      NOW,
    ],
  );
  return { id, tokenHash, email, token };
}

/**
 * The reporter the production wiring installs (ADR-0074). Tests that assert on
 * its output need the real one; the count helper exists because the registry is
 * process-wide and other cases in this lane share it.
 */
async function failedCountFor(kind: EmailDeliveryKind): Promise<number> {
  const match = (await getMetrics()).match(
    new RegExp(
      `^aihub_email_delivery_failed_total\\{kind="${kind}"\\} (\\d+)$`,
      'm',
    ),
  );
  return match === null ? 0 : Number(match[1]);
}

/** Everything Nest printed on stderr while the callback ran. */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return written.join('');
}

/** The parts of a message body a provider SDK error tends to echo back. */
const BODY_FRAGMENT =
  'Dùng mã xác minh một lần này để kích hoạt tài khoản AIHUB';

/**
 * Stands in for what a provider SDK actually rejects with: the recipient, the
 * token, a slice of the submitted body, and a raw response envelope, all in one
 * message. Nothing downstream may forward any of it.
 */
function leakyProviderError(email: string, token: string): Error {
  return new Error(
    `Resend email delivery failed: {"statusCode":422,` +
      `"name":"validation_error",` +
      `"message":"The email address ${email} is not valid",` +
      `"to":["${email}"],` +
      `"text":"${BODY_FRAGMENT}: ${token}"}`,
  );
}

/** Every text column an operator can read off a failed or cancelled request. */
async function storedEvidenceOf(id: string): Promise<string> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM email_delivery_requests WHERE id = $1',
    [id],
  );
  return JSON.stringify(rows[0] ?? {});
}

function poller(
  owner: string,
  sender: EmailSenderPort,
  now: () => Date = (): Date => NOW,
): EmailDeliveryPoller {
  return new EmailDeliveryPoller(
    store,
    new PostgresEmailCredentialRepository(client),
    cipher,
    sender,
    now,
    { hash },
    { owner, onTerminalFailure: reportTerminalEmailDeliveryFailure },
  );
}

class RecordingSender implements EmailSenderPort {
  sends: { kind: EmailDeliveryKind; idempotencyKey: string | undefined }[] = [];
  failure: Error | undefined;

  async sendVerificationEmail(
    _input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('verification_email', options);
  }

  async sendPasswordResetEmail(
    _input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('password_reset_email', options);
  }

  async sendOrganizationInviteEmail(
    _input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('organization_invite_email', options);
  }

  private async record(
    kind: EmailDeliveryKind,
    options: EmailDispatchOptions | undefined,
  ): Promise<void> {
    this.sends.push({ kind, idempotencyKey: options?.idempotencyKey });
    if (this.failure !== undefined) throw this.failure;
  }
}

interface Row {
  readonly status: string;
  readonly attempts: number;
  readonly payload_ciphertext: string | null;
  readonly cancel_reason: string | null;
  readonly last_error_code: string | null;
  readonly last_attempt_at: Date | null;
  readonly completed_at: Date | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly failure_reported_at: Date | null;
}

async function rowOf(id: string): Promise<Row> {
  const result = await pool.query<Row>(
    `SELECT status, attempts, payload_ciphertext, cancel_reason, last_error_code,
            last_attempt_at, completed_at, lease_owner, lease_expires_at,
            failure_reported_at
     FROM email_delivery_requests WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('expected an email delivery request');
  return row;
}

function claim(
  owner: string,
  overrides: { now?: Date; limit?: number; leaseMs?: number } = {},
): Promise<readonly EmailDeliveryRequestRecord[]> {
  return store.claim({
    owner,
    limit: overrides.limit ?? 10,
    leaseMs: overrides.leaseMs ?? 60_000,
    now: overrides.now ?? NOW,
  });
}

async function setAttemptEvidence(
  id: string,
  attempts: number,
  lastAttemptAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE email_delivery_requests
     SET attempts = $2, last_attempt_at = $3
     WHERE id = $1`,
    [id, attempts, lastAttemptAt],
  );
}

describe('email outbox dispatch poller', () => {
  describe('claims', () => {
    it('gives every queued request to exactly one of two pollers', async () => {
      await seedRequest();
      await seedRequest();
      await seedRequest();

      const [first, second] = await Promise.all([
        claim(OWNER_A),
        claim(OWNER_B),
      ]);

      const claimed = [...first, ...second].map((row) => row.id);
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed).size).toBe(3);
    });

    it('hands no row to a second poller while the first still holds its lease', async () => {
      const seeded = await seedRequest();

      const first = await claim(OWNER_A);
      const second = await claim(OWNER_B);

      expect(first.map((row) => row.id)).toEqual([seeded.id]);
      expect(second).toEqual([]);
    });

    it('releases a request from a claimant that stopped holding it', async () => {
      const seeded = await seedRequest();
      await claim(OWNER_A, { leaseMs: 30_000 });

      const afterExpiry = await claim(OWNER_B, {
        now: new Date(NOW.getTime() + 30_001),
      });

      expect(afterExpiry.map((row) => row.id)).toEqual([seeded.id]);
    });

    it('refuses a transition from the claimant whose lease was taken over', async () => {
      // A batch that outlives its lease lets a second instance reclaim the row.
      // The first one is then still holding a request record it no longer owns,
      // and must not be able to spend its attempt or clear the new owner's lease.
      const seeded = await seedRequest();
      await claim(OWNER_A, { leaseMs: 30_000 });
      await claim(OWNER_B, { now: new Date(NOW.getTime() + 30_001) });

      await expect(
        store.reserveAttempt({
          id: seeded.id,
          attemptedAt: NOW,
          owner: OWNER_A,
        }),
      ).rejects.toThrow('not in a queued state');

      const row = await rowOf(seeded.id);
      expect(row.attempts).toBe(0);
      expect(row.lease_owner).toBe(OWNER_B);
    });

    it('lets the current owner spend the attempt and finish a taken-over row', async () => {
      const seeded = await seedRequest();
      await claim(OWNER_A, { leaseMs: 30_000 });
      await claim(OWNER_B, { now: new Date(NOW.getTime() + 30_001) });

      await store.reserveAttempt({
        id: seeded.id,
        attemptedAt: NOW,
        owner: OWNER_B,
      });
      await store.markProviderAccepted({
        id: seeded.id,
        attemptedAt: NOW,
        owner: OWNER_B,
      });

      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });

    it('claims no more than the batch it asked for', async () => {
      for (let index = 0; index < 4; index += 1) await seedRequest();

      expect(await claim(OWNER_A, { limit: 2 })).toHaveLength(2);
    });

    it('never claims a request the provider already accepted', async () => {
      const seeded = await seedRequest();
      await poller(OWNER_A, new RecordingSender()).runOnce();

      expect(await claim(OWNER_B)).toEqual([]);
      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });

    it('never claims a request that already failed or was cancelled', async () => {
      const failed = await seedRequest();
      const cancelled = await seedRequest();
      await pool.query(
        `UPDATE email_delivery_requests
         SET status = 'failed', payload_ciphertext = NULL, completed_at = $2,
             attempts = 3, last_attempt_at = $2
         WHERE id = $1`,
        [failed.id, NOW],
      );
      await pool.query(
        `UPDATE email_delivery_requests
         SET status = 'cancelled', payload_ciphertext = NULL, completed_at = $2,
             cancel_reason = 'not_actionable'
         WHERE id = $1`,
        [cancelled.id, NOW],
      );

      expect(await claim(OWNER_A)).toEqual([]);
    });

    it('resumes a request left mid-flight by an instance that stopped', async () => {
      const seeded = await seedRequest();
      const sender = new RecordingSender();
      // The first instance claims the row and then stops without recording any
      // outcome, which is what a crash between handoff and mark looks like.
      await claim(OWNER_A, { leaseMs: 30_000 });

      const beforeExpiry = await poller(OWNER_B, sender).runOnce();
      expect(beforeExpiry.claimed).toBe(0);
      expect(sender.sends).toEqual([]);

      const afterExpiry = await poller(
        OWNER_B,
        sender,
        () => new Date(NOW.getTime() + 30_001),
      ).runOnce();

      expect(afterExpiry.providerAccepted).toBe(1);
      expect(sender.sends).toEqual([
        { kind: 'verification_email', idempotencyKey: seeded.id },
      ]);
      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });
  });

  describe('retry schedule', () => {
    it('claims a request that has never been attempted', async () => {
      const seeded = await seedRequest();

      expect((await claim(OWNER_A)).map((row) => row.id)).toEqual([seeded.id]);
    });

    it('waits a full minute after the first attempt', async () => {
      const tooSoon = await seedRequest();
      const due = await seedRequest();
      await setAttemptEvidence(tooSoon.id, 1, new Date(NOW.getTime() - 59_000));
      await setAttemptEvidence(due.id, 1, new Date(NOW.getTime() - 61_000));

      expect((await claim(OWNER_A)).map((row) => row.id)).toEqual([due.id]);
    });

    it('waits five minutes after the second attempt', async () => {
      const tooSoon = await seedRequest();
      const due = await seedRequest();
      await setAttemptEvidence(
        tooSoon.id,
        2,
        new Date(NOW.getTime() - 5 * MINUTE + 1_000),
      );
      await setAttemptEvidence(
        due.id,
        2,
        new Date(NOW.getTime() - 5 * MINUTE - 1_000),
      );

      expect((await claim(OWNER_A)).map((row) => row.id)).toEqual([due.id]);
    });

    it('does not claim a request that has used all three attempts', async () => {
      const seeded = await seedRequest();
      await setAttemptEvidence(
        seeded.id,
        3,
        new Date(NOW.getTime() - 60 * MINUTE),
      );

      expect(await claim(OWNER_A)).toEqual([]);
    });

    it('waits out the retry delay rather than the lease after a failed attempt', async () => {
      const seeded = await seedRequest();
      const sender = new RecordingSender();
      sender.failure = new Error('Resend email delivery failed');
      let clock = NOW;
      const failing = poller(OWNER_A, sender, () => clock);

      await failing.runOnce();
      expect((await rowOf(seeded.id)).lease_owner).toBeNull();

      // Well inside the lease the poller took, but past the one-minute delay:
      // the retry delay alone decides when the row is claimable again.
      clock = new Date(NOW.getTime() + MINUTE + 1_000);
      await failing.runOnce();

      expect(sender.sends).toHaveLength(2);
    });
  });

  describe('dispatch', () => {
    it('erases the payload once the provider accepts', async () => {
      const seeded = await seedRequest();

      await poller(OWNER_A, new RecordingSender()).runOnce();

      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'provider_accepted',
        attempts: 1,
        payload_ciphertext: null,
        lease_owner: null,
        lease_expires_at: null,
      });
    });

    it('leaves a request sealed with a key version this instance lacks queued, unerased, and claimable', async () => {
      const seeded = await seedRequest({ sealedWith: foreignCipher });
      const sender = new RecordingSender();

      await poller(OWNER_A, sender).runOnce();

      // Cancelling would erase a payload the instance that holds the key can
      // still deliver, so the row keeps its ciphertext and its attempts and
      // goes straight back into circulation.
      expect(sender.sends).toEqual([]);
      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'queued',
        attempts: 0,
        cancel_reason: null,
        lease_owner: null,
        lease_expires_at: null,
      });
      expect((await rowOf(seeded.id)).payload_ciphertext).not.toBeNull();
      expect((await claim(OWNER_B)).map((row) => row.id)).toEqual([seeded.id]);
    });

    it('cancels a request whose credential was superseded', async () => {
      const seeded = await seedRequest();
      await pool.query(
        `UPDATE email_verification_tokens
         SET consumed_at = $2, consumed_reason = 'superseded'
         WHERE token_hash = $1`,
        [seeded.tokenHash, NOW],
      );
      const sender = new RecordingSender();

      const summary = await poller(OWNER_A, sender).runOnce();

      expect(sender.sends).toEqual([]);
      expect(summary).toMatchObject({ cancelled: 1, failed: 0 });
      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'not_actionable',
        payload_ciphertext: null,
      });
    });

    it('cancels a request whose credential was revoked before dispatch', async () => {
      const seeded = await seedRequest({
        kind: 'organization_invite_email',
      });
      await pool.query(
        'UPDATE organization_invitations SET consumed_at = $2 WHERE token_hash = $1',
        [seeded.tokenHash, NOW],
      );
      const sender = new RecordingSender();

      await poller(OWNER_A, sender).runOnce();

      expect(sender.sends).toEqual([]);
      expect((await rowOf(seeded.id)).status).toBe('cancelled');
    });

    it('never dispatches a request whose credential expires at this instant', async () => {
      const seeded = await seedRequest({
        expiresAt: new Date(NOW.getTime() + 1_000),
      });
      const sender = new RecordingSender();

      const summary = await poller(
        OWNER_A,
        sender,
        () => new Date(NOW.getTime() + 1_000),
      ).runOnce();

      expect(sender.sends).toEqual([]);
      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'credential_expired',
        payload_ciphertext: null,
      });
      expect(summary.cancelled).toBe(1);
    });

    it('cancels a request whose credential is no longer in its table', async () => {
      const seeded = await seedRequest();
      await pool.query(
        'DELETE FROM email_verification_tokens WHERE token_hash = $1',
        [seeded.tokenHash],
      );
      const sender = new RecordingSender();

      await poller(OWNER_A, sender).runOnce();

      expect(sender.sends).toEqual([]);
      expect((await rowOf(seeded.id)).cancel_reason).toBe('not_actionable');
    });

    it('gives up after the third attempt and erases the payload', async () => {
      const seeded = await seedRequest();
      const sender = new RecordingSender();
      sender.failure = new Error('Resend email delivery failed');
      let clock = NOW;
      const failing = poller(OWNER_A, sender, () => clock);

      await failing.runOnce();
      clock = new Date(NOW.getTime() + MINUTE + 1_000);
      await failing.runOnce();
      clock = new Date(NOW.getTime() + 6 * MINUTE + 2_000);
      await failing.runOnce();

      expect(sender.sends).toHaveLength(3);
      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'failed',
        attempts: 3,
        last_error_code: 'provider_rejected',
        payload_ciphertext: null,
        lease_owner: null,
      });
    });

    it('gives the provider at most three attempts even when every transition fails', async () => {
      const seeded = await seedRequest();
      const sender = new RecordingSender();
      sender.failure = new Error('Resend email delivery failed');
      // Every outcome transition fails, which is the case the attempt cap has to
      // survive: the row keeps its lease, its payload, and its attempts, so only
      // the reservation taken before the call can bound the provider.
      const unreachable: EmailDispatchStorePort = {
        claim: (input) => store.claim(input),
        reserveAttempt: (input) => store.reserveAttempt(input),
        markProviderAccepted: async () => {
          throw new Error('store is unavailable');
        },
        markFailed: async () => {
          throw new Error('store is unavailable');
        },
        recordFailedAttempt: async () => {
          throw new Error('store is unavailable');
        },
        markCancelled: (input) => store.markCancelled(input),
        releaseDeferred: (input) => store.releaseDeferred(input),
        claimUnreportedFailures: (input) =>
          store.claimUnreportedFailures(input),
        markFailureReported: (input) => store.markFailureReported(input),
        releaseFailureNotification: (input) =>
          store.releaseFailureNotification(input),
        failExhausted: (input) => store.failExhausted(input),
      };
      let clock = NOW;
      const failing = new EmailDeliveryPoller(
        unreachable,
        new PostgresEmailCredentialRepository(client),
        cipher,
        sender,
        () => clock,
        { hash },
        {
          owner: OWNER_A,
          onTerminalFailure: reportTerminalEmailDeliveryFailure,
        },
      );

      for (const minutes of [0, 1, 6, 20, 40]) {
        clock = new Date(NOW.getTime() + minutes * MINUTE);
        await failing.runOnce();
      }

      expect(sender.sends).toHaveLength(3);
      expect((await rowOf(seeded.id)).attempts).toBe(3);
    });

    it('presents the same idempotency key on every attempt of one request', async () => {
      const seeded = await seedRequest();
      const sender = new RecordingSender();
      sender.failure = new Error('Resend email delivery failed');
      let clock = NOW;
      const failing = poller(OWNER_A, sender, () => clock);

      await failing.runOnce();
      clock = new Date(NOW.getTime() + MINUTE + 1_000);
      await failing.runOnce();
      clock = new Date(NOW.getTime() + 6 * MINUTE + 2_000);
      sender.failure = undefined;
      await failing.runOnce();

      expect(sender.sends.map((send) => send.idempotencyKey)).toEqual([
        seeded.id,
        seeded.id,
        seeded.id,
      ]);
    });

    it('sends a password reset request for its own credential table', async () => {
      const seeded = await seedRequest({ kind: 'password_reset_email' });
      const sender = new RecordingSender();

      await poller(OWNER_A, sender).runOnce();

      expect(sender.sends).toEqual([
        { kind: 'password_reset_email', idempotencyKey: seeded.id },
      ]);
      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });

    it('sends an organization invitation with the name and role it was committed with', async () => {
      const seeded = await seedRequest({
        kind: 'organization_invite_email',
        organizationName: 'Resonance',
        role: 'owner',
      });
      const delivered: unknown[] = [];
      const sender: EmailSenderPort = {
        async sendVerificationEmail() {
          throw new Error('wrong kind dispatched');
        },
        async sendPasswordResetEmail() {
          throw new Error('wrong kind dispatched');
        },
        async sendOrganizationInviteEmail(input) {
          delivered.push(input);
        },
      };

      await poller(OWNER_A, sender).runOnce();

      expect(delivered).toEqual([
        expect.objectContaining({
          organizationName: 'Resonance',
          role: 'owner',
        }),
      ]);
      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });

    it('will not move a request the provider already accepted back to failed', async () => {
      const seeded = await seedRequest();
      await poller(OWNER_A, new RecordingSender()).runOnce();

      await expect(
        store.markFailed({
          id: seeded.id,
          failedAt: NOW,
          errorCode: 'timeout',
          owner: OWNER_A,
        }),
      ).rejects.toThrow('not in a queued state');

      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });
  });

  /**
   * What an operator is left holding once a dispatch is given up on. The row is
   * the durable evidence, so it must carry the bounded codes and the attempt
   * timeline and nothing the request was addressed with.
   */
  describe('terminal failure evidence', () => {
    /** Runs a request through its third attempt against a rejecting provider. */
    async function exhaust(
      sender: RecordingSender,
      kind: EmailDeliveryKind = 'verification_email',
      already?: SeededRequest,
    ): Promise<SeededRequest> {
      const seeded = already ?? (await seedRequest({ kind }));
      let clock = NOW;
      const failing = poller(OWNER_A, sender, () => clock);
      await failing.runOnce();
      clock = new Date(NOW.getTime() + MINUTE + 1_000);
      await failing.runOnce();
      clock = new Date(NOW.getTime() + 6 * MINUTE + 2_000);
      await failing.runOnce();
      return seeded;
    }

    function rejectingProvider(): RecordingSender {
      const sender = new RecordingSender();
      sender.failure = new Error('Resend email delivery failed');
      return sender;
    }

    it('fails the request and keeps the attempt timeline, the bounded code, and no payload', async () => {
      const sender = rejectingProvider();

      const seeded = await exhaust(sender);

      const row = await rowOf(seeded.id);
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(3);
      expect(row.last_error_code).toBe('provider_rejected');
      // Nothing else about the attempt is stored: cancellation has its own
      // reason column and this request was never cancelled.
      expect(row.cancel_reason).toBeNull();
      expect(row.payload_ciphertext).toBeNull();
      expect(row.lease_owner).toBeNull();
      expect(row.lease_expires_at).toBeNull();
      expect(row.completed_at).toEqual(
        new Date(NOW.getTime() + 6 * MINUTE + 2_000),
      );
    });

    it('reports a terminal failure whose notification was lost, on a later pass', async () => {
      const seeded = await exhaust(rejectingProvider());
      // Exactly what a process exit between the markFailed commit and the
      // callback leaves behind: a terminal row with no record of a signal.
      await pool.query(
        'UPDATE email_delivery_requests SET failure_reported_at = NULL WHERE id = $1',
        [seeded.id],
      );
      const before = await failedCountFor('verification_email');

      const emitted = await captureStderr(async () => {
        await poller(OWNER_B, new RecordingSender()).runOnce();
      });

      expect(emitted).toContain('exhausted its attempts');
      expect(await failedCountFor('verification_email')).toBe(before + 1);
      expect((await rowOf(seeded.id)).failure_reported_at).not.toBeNull();

      // Once, not once per pass: the durable record ends the reconciliation.
      const again = await captureStderr(async () => {
        await poller(OWNER_B, new RecordingSender()).runOnce();
      });
      expect(again).not.toContain('exhausted its attempts');
      expect(await failedCountFor('verification_email')).toBe(before + 1);
    });

    it('records the notification on the request it gave up on', async () => {
      const seeded = await exhaust(rejectingProvider());

      expect((await rowOf(seeded.id)).failure_reported_at).toEqual(
        new Date(NOW.getTime() + 6 * MINUTE + 2_000),
      );
    });

    it('gives up a request whose last attempt never recorded an outcome', async () => {
      // A process that died between reserving the third attempt and writing the
      // result. The claim predicate excludes it because the cap is reached, so
      // without a recovery path it would keep its ciphertext and stay silent.
      const seeded = await seedRequest();
      await pool.query(
        `UPDATE email_delivery_requests
         SET attempts = 3, last_attempt_at = $2, last_error_code = 'provider_rejected',
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1`,
        [seeded.id, new Date(NOW.getTime() - 10 * MINUTE)],
      );
      const before = await failedCountFor('verification_email');
      const sender = new RecordingSender();

      await poller(OWNER_B, sender, () => NOW).runOnce();

      // No fourth provider call: the cap is the cap.
      expect(sender.sends).toEqual([]);
      expect(await rowOf(seeded.id)).toMatchObject({
        status: 'failed',
        attempts: 3,
        last_error_code: 'outcome_unknown',
        payload_ciphertext: null,
      });
      expect(await failedCountFor('verification_email')).toBe(before + 1);
    });

    it('reports one terminal failure once when two instances reconcile it at the same time', async () => {
      const seeded = await exhaust(rejectingProvider());
      await pool.query(
        'UPDATE email_delivery_requests SET failure_reported_at = NULL WHERE id = $1',
        [seeded.id],
      );
      const before = await failedCountFor('verification_email');

      // Both instances find the same unreported terminal row. Claiming it is one
      // atomic statement, so between them they emit one event, not two.
      await Promise.all([
        poller(OWNER_A, new RecordingSender()).runOnce(),
        poller(OWNER_B, new RecordingSender()).runOnce(),
      ]);

      expect(await failedCountFor('verification_email')).toBe(before + 1);
      expect((await rowOf(seeded.id)).failure_reported_at).not.toBeNull();
    });

    it('reclaims a notification whose instance died holding the lease', async () => {
      const seeded = await exhaust(rejectingProvider());
      await pool.query(
        'UPDATE email_delivery_requests SET failure_reported_at = NULL WHERE id = $1',
        [seeded.id],
      );
      const before = await failedCountFor('verification_email');

      // What an exit between claiming and emitting leaves behind: the lease is
      // still held, but the reported stamp was never written.
      await pool.query(
        `UPDATE email_delivery_requests
         SET failure_notify_lease_expires_at = $2
         WHERE id = $1`,
        [seeded.id, new Date(NOW.getTime() + MINUTE)],
      );

      // While the lease is live, nobody reports it.
      await poller(OWNER_B, new RecordingSender()).runOnce();
      expect(await failedCountFor('verification_email')).toBe(before);

      // Once it lapses the alert is owed again: delayed, never lost.
      const later = new Date(NOW.getTime() + MINUTE + 1_000);
      await poller(OWNER_B, new RecordingSender(), () => later).runOnce();
      expect(await failedCountFor('verification_email')).toBe(before + 1);
      expect((await rowOf(seeded.id)).failure_reported_at).not.toBeNull();
    });

    it('counts the terminal failure under its email kind', async () => {
      const before = await failedCountFor('verification_email');

      await exhaust(rejectingProvider());

      expect(await failedCountFor('verification_email')).toBe(before + 1);
    });

    it('raises one structured error event naming the request, its kind, and its code', async () => {
      const emitted = await captureStderr(async () => {
        await exhaust(rejectingProvider(), 'organization_invite_email');
      });

      // One event, not one per attempt: only the attempt that ended the request
      // is terminal, so paging once is the whole point of the counter.
      expect(emitted.match(/exhausted its attempts/g)).toHaveLength(1);
      expect(emitted).toContain('ERROR');
      expect(emitted).toContain('organization_invite_email');
      expect(emitted).toContain('provider_rejected');
      expect(emitted).toMatch(/edr_[0-9A-Z]{26}/);
    });

    it('raises no event and counts nothing while attempts remain', async () => {
      const seeded = await seedRequest();
      const sender = rejectingProvider();
      const before = await failedCountFor('verification_email');

      const emitted = await captureStderr(async () => {
        await poller(OWNER_A, sender).runOnce();
      });

      expect(emitted).not.toContain('exhausted its attempts');
      expect(await failedCountFor('verification_email')).toBe(before);
      expect((await rowOf(seeded.id)).status).toBe('queued');
    });

    it.each([
      ['a superseded credential', 'superseded'],
      ['a revoked invitation', 'revoked'],
    ] as const)(
      'stays silent for a request cancelled by %s',
      async (_label, closure) => {
        const revoked = closure === 'revoked';
        const kind: EmailDeliveryKind = revoked
          ? 'organization_invite_email'
          : 'verification_email';
        const seeded = await seedRequest({ kind });
        if (revoked) {
          await pool.query(
            'UPDATE organization_invitations SET consumed_at = $2 WHERE token_hash = $1',
            [seeded.tokenHash, NOW],
          );
        } else {
          await pool.query(
            `UPDATE email_verification_tokens
             SET consumed_at = $2, consumed_reason = 'superseded'
             WHERE token_hash = $1`,
            [seeded.tokenHash, NOW],
          );
        }
        const before = await failedCountFor(kind);

        const emitted = await captureStderr(async () => {
          await poller(OWNER_A, new RecordingSender()).runOnce();
        });

        // Cancellation is expected lifecycle handling (ADR-0074): paging on it
        // would train operators to ignore the event that does mean something.
        expect(emitted).not.toContain('exhausted its attempts');
        expect(emitted).not.toContain('ERROR');
        expect(await failedCountFor(kind)).toBe(before);
        expect(await rowOf(seeded.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'not_actionable',
          payload_ciphertext: null,
        });
      },
    );

    it('keeps the recipient, the token, the message body, and the raw provider response out of every trace', async () => {
      const sender = new RecordingSender();
      const seeded = await seedRequest();
      sender.failure = leakyProviderError(seeded.email, seeded.token);

      const emitted = await captureStderr(async () => {
        await exhaust(sender, 'verification_email', seeded);
      });

      // The whole trace an operator leaves with: the emitted event, the metric
      // exposition, and every column of the row itself.
      const trace = [
        emitted,
        await getMetrics(),
        await storedEvidenceOf(seeded.id),
      ].join('\n');
      for (const secret of [
        seeded.email,
        seeded.token,
        BODY_FRAGMENT,
        'validation_error',
        'statusCode',
      ]) {
        expect(trace).not.toContain(secret);
      }
      // The event itself carries three bounded fields and nothing else, so any
      // address or field name appearing in it is a leak whatever its source.
      expect(emitted).not.toContain('@');
      expect(emitted).not.toMatch(/token|\bto=|\btext=|\bbody=|\bpayload/i);
      // What is left is the bounded code, which is the only failure evidence the
      // dispatch path is allowed to keep.
      expect(emitted).toContain('error=provider_rejected');
    });
  });
});
