import { Logger } from '@nestjs/common';

import type { EmailDeliveryQueryClient } from './postgres-email-delivery-request.repository';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const ROW_ID = 'edr_01J00000000000000000000000';

function clientReturning(
  row: Record<string, unknown>,
): EmailDeliveryQueryClient {
  return {
    query: async (): Promise<readonly Record<string, unknown>[]> => [row],
  };
}

function queuedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ROW_ID,
    kind: 'verification_email',
    status: 'queued',
    payload_ciphertext: 'sealed',
    attempts: 0,
    last_attempt_at: null,
    last_error_code: null,
    cancel_reason: null,
    created_at: NOW,
    completed_at: null,
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
  it('skips an unknown kind without failing valid rows in the same claim', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const knownId = 'edr_01J00000000000000000000001';
    const client: EmailDeliveryQueryClient = {
      query: async () => [
        queuedRow({
          kind: 'carrier_pigeon_email',
          payload_ciphertext: 'secret',
        }),
        queuedRow({ id: knownId }),
      ],
    };

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
        payload_ciphertext: null,
        last_error_code: 'timeout',
        cancel_reason: 'credential_revoked',
        completed_at: NOW,
      }),
    );

    expect(claimed[0]).toMatchObject({
      lastErrorCode: 'timeout',
      cancelReason: 'credential_revoked',
    });
  });

  it.each([
    ['a non-string kind', { kind: 42 }],
    ['a status outside the table vocabulary', { status: 'dispatched' }],
    [
      'an error code outside the bounded set',
      {
        last_error_code: 'provider said no',
        status: 'failed',
        completed_at: NOW,
      },
    ],
    [
      'a cancellation reason outside the bounded set',
      { cancel_reason: 'because', status: 'cancelled', completed_at: NOW },
    ],
    ['a missing identifier', { id: undefined }],
    ['a non-numeric attempt count', { attempts: 'many' }],
    ['a missing creation instant', { created_at: undefined }],
    ['a creation instant that is not a date', { created_at: 'yesterday' }],
    [
      'an attempt instant that is not a date',
      { last_attempt_at: 'a while ago' },
    ],
    ['a ciphertext that is not text', { payload_ciphertext: 42 }],
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
