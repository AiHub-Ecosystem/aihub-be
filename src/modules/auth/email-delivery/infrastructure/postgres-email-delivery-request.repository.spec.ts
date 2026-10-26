import { Logger } from '@nestjs/common';
import { EmailDeliveryTransactionAdapter } from './email-delivery-transaction.adapter';

import type { InsertEmailDeliveryRequestInput } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  type QueryFake,
  ScriptedPrisma,
  prismaFromQueryFake,
} from '@/modules/persistence/testing/query-fake-client';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const CLAIM = new Date(NOW.getTime() + 30_000);
const ROW_ID = 'edr_01J00000000000000000000000';

function clientReturningRows(rows: readonly Record<string, unknown>[]) {
  const query = async (): Promise<readonly Record<string, unknown>[]> => rows;
  const fake: QueryFake = {
    query,
    transaction: (callback) => callback({ query }),
  };
  return prismaFromQueryFake(fake);
}

function clientReturning(row: Record<string, unknown>) {
  return clientReturningRows([row]);
}

function queuedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ROW_ID,
    kind: 'verification_email',
    status: 'queued',
    payloadCiphertext: 'sealed',
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    cancelReason: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function claim(row: Record<string, unknown>) {
  return new PostgresEmailDeliveryRequestRepository().claim(
    clientReturning(row),
    { owner: 'instance-a', limit: 10, leaseMs: 105_000, now: NOW },
  );
}

describe('PostgresEmailDeliveryRequestRepository', () => {
  it('inserts the outbox row through the caller Prisma transaction', async () => {
    const script = new ScriptedPrisma();
    const transaction = new EmailDeliveryTransactionAdapter(script.client());
    const input: InsertEmailDeliveryRequestInput = {
      id: ROW_ID,
      kind: 'verification_email',
      payloadCiphertext: 'sealed',
      createdAt: NOW,
    };

    await new PostgresEmailDeliveryRequestRepository().insert(
      transaction,
      input,
    );

    expect(script.statements).toEqual([
      {
        name: 'emailDeliveryRequest.create',
        args: [
          {
            data: {
              id: input.id,
              kind: input.kind,
              status: 'queued',
              payloadCiphertext: input.payloadCiphertext,
              createdAt: input.createdAt,
            },
          },
        ],
        transaction: 0,
      },
    ]);
  });

  it('stores only opaque invitation scheduling IDs on invitation rows', async () => {
    const script = new ScriptedPrisma();
    const transaction = new EmailDeliveryTransactionAdapter(script.client());
    const input: InsertEmailDeliveryRequestInput = {
      id: ROW_ID,
      kind: 'organization_invite_email',
      organizationId: 'org_opaque',
      inviterId: 'usr_opaque',
      payloadCiphertext: 'sealed',
      createdAt: NOW,
    };

    await new PostgresEmailDeliveryRequestRepository().insert(
      transaction,
      input,
    );

    expect(script.statements[0]?.args[0]).toMatchObject({
      data: {
        organizationId: 'org_opaque',
        inviterId: 'usr_opaque',
      },
    });
  });

  it('skips an unknown kind without failing valid rows in the same claim', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const knownId = 'edr_01J00000000000000000000001';
    const client = clientReturningRows([
      queuedRow({
        kind: 'carrier_pigeon_email',
        payloadCiphertext: 'secret',
      }),
      queuedRow({ id: knownId }),
    ]);

    try {
      const claimed = await new PostgresEmailDeliveryRequestRepository().claim(
        client,
        { owner: 'instance-a', limit: 10, leaseMs: 105_000, now: NOW },
      );

      expect(claimed.map(({ id }) => id)).toEqual([knownId]);
      expect(warn).toHaveBeenCalledWith(
        'Skipped 1 email delivery requests with unrecognized kinds',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'carrier_pigeon_email',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('maps a queued claim onto the declared record', async () => {
    const claimed = await claim(queuedRow());

    expect(claimed).toEqual([
      {
        id: ROW_ID,
        kind: 'verification_email',
        status: 'queued',
        payloadCiphertext: 'sealed',
        attempts: 0,
        lastAttemptAt: null,
        lastErrorCode: null,
        cancelReason: null,
        createdAt: NOW,
        completedAt: null,
      },
    ]);
  });

  it('carries the stored error code and cancellation reason through', async () => {
    const claimed = await claim(
      queuedRow({
        status: 'cancelled',
        payloadCiphertext: null,
        lastErrorCode: 'timeout',
        cancelReason: 'credential_revoked',
        completedAt: NOW,
      }),
    );

    expect(claimed[0]).toMatchObject({
      lastErrorCode: 'timeout',
      cancelReason: 'credential_revoked',
    });
  });

  it('reads the permanent provider rejection code before the writer rollout', async () => {
    const failures =
      await new PostgresEmailDeliveryRequestRepository().claimUnreportedFailures(
        clientReturning({
          ...queuedRow({
            status: 'failed',
            payloadCiphertext: null,
            lastErrorCode: 'provider_permanent_rejection',
            completedAt: NOW,
          }),
          claim: CLAIM,
        }),
        { limit: 1, now: NOW, leaseMs: 30_000 },
      );

    expect(failures[0]?.lastErrorCode).toBe('provider_permanent_rejection');
  });

  it('reads key_unavailable before the writer rollout', async () => {
    const failures =
      await new PostgresEmailDeliveryRequestRepository().claimUnreportedFailures(
        clientReturning({
          ...queuedRow({
            status: 'failed',
            payloadCiphertext: null,
            lastErrorCode: 'key_unavailable',
            completedAt: NOW,
          }),
          claim: CLAIM,
        }),
        { limit: 1, now: NOW, leaseMs: 30_000 },
      );

    expect(failures[0]?.lastErrorCode).toBe('key_unavailable');
  });

  it('returns each failure claim with the lease it wrote, which identifies the claim (#989)', async () => {
    const failures =
      await new PostgresEmailDeliveryRequestRepository().claimUnreportedFailures(
        clientReturning({
          ...queuedRow({
            status: 'failed',
            payloadCiphertext: null,
            lastErrorCode: 'timeout',
            completedAt: NOW,
          }),
          claim: CLAIM,
        }),
        { limit: 1, now: NOW, leaseMs: 30_000 },
      );

    expect(failures[0]?.claim).toEqual(CLAIM);
  });

  it('refuses a failure claim with no lease rather than inventing one', async () => {
    await expect(
      new PostgresEmailDeliveryRequestRepository().claimUnreportedFailures(
        clientReturning(
          queuedRow({
            status: 'failed',
            payloadCiphertext: null,
            lastErrorCode: 'timeout',
            completedAt: NOW,
          }),
        ),
        { limit: 1, now: NOW, leaseMs: 30_000 },
      ),
    ).rejects.toThrow('Email delivery failure claim is invalid');
  });

  it.each([
    ['a non-string kind', { kind: 42 }],
    ['a status outside the table vocabulary', { status: 'dispatched' }],
    [
      'an error code outside the bounded set',
      {
        lastErrorCode: 'provider said no',
        status: 'failed',
        completedAt: NOW,
      },
    ],
    [
      'a cancellation reason outside the bounded set',
      { cancelReason: 'because', status: 'cancelled', completedAt: NOW },
    ],
    ['a missing identifier', { id: undefined }],
    ['a non-numeric attempt count', { attempts: 'many' }],
    ['a missing creation instant', { createdAt: undefined }],
    ['a creation instant that is not a date', { createdAt: 'yesterday' }],
    ['an attempt instant that is not a date', { lastAttemptAt: 'a while ago' }],
    ['a ciphertext that is not text', { payloadCiphertext: 42 }],
  ])(
    'refuses %s rather than handing the application a cast',
    async (_l, over) => {
      await expect(claim(queuedRow(over))).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    },
  );

  it('keeps unknown kinds visible as one bounded backlog bucket', async () => {
    const repository = new PostgresEmailDeliveryRequestRepository();
    const backlog = await repository.backlog(
      clientReturning({
        kind: 'unknown',
        queued: 2,
        oldest_age_seconds: 45,
      }),
      { now: NOW },
    );

    expect(backlog).toEqual([
      { kind: 'unknown', queued: 2, oldestAgeSeconds: 45 },
    ]);
  });
});
