import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { EmailDeliveryPoller } from '@/modules/auth/application/email-delivery-poller';
import type {
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
} from '@/modules/auth/application/email-delivery-request.port';
import type {
  EmailDispatchOptions,
  EmailSenderPort,
} from '@/modules/auth/application/email-sender.port';
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
}

interface SeedOptions {
  readonly kind?: EmailDeliveryKind;
  readonly expiresAt?: Date;
  readonly organizationName?: string;
  readonly role?: 'owner' | 'admin' | 'member';
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
    [id, kind, cipher.encrypt(JSON.stringify(payload)), NOW],
  );
  return { id, tokenHash };
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
    { owner },
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
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
}

async function rowOf(id: string): Promise<Row> {
  const result = await pool.query<Row>(
    `SELECT status, attempts, payload_ciphertext, cancel_reason, last_error_code,
            lease_owner, lease_expires_at
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

    it('cancels a request whose credential was superseded, without alerting', async () => {
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
        }),
      ).rejects.toThrow('not in a queued state');

      expect((await rowOf(seeded.id)).status).toBe('provider_accepted');
    });
  });
});
