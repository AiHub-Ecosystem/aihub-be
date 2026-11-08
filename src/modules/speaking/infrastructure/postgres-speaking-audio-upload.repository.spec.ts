import type { Prisma, PrismaClient } from '@prisma-client/client';

import { AppError } from '@/common/errors/app-error';

import type { SpeakingAudioAsset } from '@/modules/speaking/domain/speaking-audio-asset';
import { PostgresSpeakingAudioUploadRepository } from './postgres-speaking-audio-upload.repository';

describe('PostgresSpeakingAudioUploadRepository completion timeout', () => {
  it('sets the transaction-local idle timeout before preparing the object', async () => {
    let prepareCalledAfterSetConfig = false;
    let setConfigCalled = false;
    const row = {
      id: 'aud_01J00000000000000000000001',
      organizationId: 'org_speaking_upload',
      endUserId: 'learner-42',
      environment: 'production',
      objectKey:
        'orgs/org_speaking_upload/speaking/aud_01J00000000000000000000001/original',
      contentType: 'audio/wav' as const,
      byteSize: 100,
      status: 'open',
      createdAt: new Date('2026-10-14T12:00:00.000Z'),
      expiresAt: new Date('2026-10-14T13:00:00.000Z'),
    };
    const asset: SpeakingAudioAsset = {
      assetId: row.id,
      organizationId: row.organizationId,
      endUserId: row.endUserId,
      environment: 'production',
      objectKey: row.objectKey,
      contentType: row.contentType,
      byteSize: row.byteSize,
      acceptedAt: row.createdAt,
      retentionExpiresAt: new Date('2026-11-13T12:00:00.000Z'),
    };
    const query = jest.fn(async (sql: string, ..._values: unknown[]) => {
      if (sql.includes('set_config')) {
        setConfigCalled = true;
        return [];
      }
      return [row];
    });
    const transaction = {
      $queryRawUnsafe: query,
      speakingAudioAsset: { create: jest.fn().mockResolvedValue(undefined) },
      speakingAudioUploadIntent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as Prisma.TransactionClient;
    const client = {
      $transaction: jest.fn(
        async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaClient;
    const repository = new PostgresSpeakingAudioUploadRepository(client);

    await repository.completeIntent({
      owner: {
        assetId: row.id,
        organizationId: row.organizationId,
        endUserId: row.endUserId,
        environment: 'production',
      },
      now: () => new Date('2026-10-14T12:00:00.000Z'),
      prepare: async () => {
        prepareCalledAfterSetConfig = setConfigCalled;
        return { kind: 'accepted', asset };
      },
    });

    // set_config was called with the 35 000 ms idle timeout value.
    expect(query.mock.calls[0]?.[0]).toContain('set_config');
    expect(query.mock.calls[0]?.[1]).toBe('35000');
    // prepare ran only after set_config had already been called.
    expect(prepareCalledAfterSetConfig).toBe(true);
  });
});

describe('PostgresSpeakingAudioUploadRepository Organization ceilings (#374)', () => {
  const intent = {
    assetId: 'aud_01J00000000000000000000001',
    organizationId: 'org_speaking_upload',
    endUserId: 'learner-42',
    environment: 'production' as const,
    objectKey:
      'orgs/org_speaking_upload/speaking/aud_01J00000000000000000000001/original',
    contentType: 'audio/wav' as const,
    byteSize: 1_024,
    createdAt: new Date('2026-10-14T12:00:00.000Z'),
    expiresAt: new Date('2026-10-14T13:00:00.000Z'),
    status: 'open' as const,
  };

  function repositoryWith(holding: {
    readonly openIntents: number;
    readonly issuedInWindow: number;
    readonly storedBytes: bigint;
  }) {
    const create = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(async (sql: string, ..._values: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return [];
      return [holding];
    });
    const transaction = {
      $queryRawUnsafe: query,
      speakingAudioUploadIntent: { create },
    } as unknown as Prisma.TransactionClient;
    const client = {
      $transaction: jest.fn(
        async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaClient;
    return {
      repository: new PostgresSpeakingAudioUploadRepository(client),
      create,
      query,
    };
  }

  it('takes the per-organization lock before counting', async () => {
    const { repository, query } = repositoryWith({
      openIntents: 0,
      issuedInWindow: 0,
      storedBytes: 0n,
    });

    await repository.createIntentWithinCeiling({
      intent,
      decide: () => ({ kind: 'within' }),
    });

    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0]?.[1]).toBe(
      'org_speaking_upload:speaking-audio:intents',
    );
    // The holding query runs after the lock, never before it.
    expect(query.mock.calls[1]?.[0]).toContain('openIntents');
  });

  it('writes no intent when the ceiling refuses', async () => {
    const { repository, create } = repositoryWith({
      openIntents: 8,
      issuedInWindow: 0,
      storedBytes: 0n,
    });

    const decision = await repository.createIntentWithinCeiling({
      intent,
      decide: () => ({
        kind: 'refused',
        refusal: new AppError({
          code: 'RATE_LIMITED',
          message: 'limit',
          retryable: true,
        }),
      }),
    });

    expect(decision.kind).toBe('refused');
    expect(create).not.toHaveBeenCalled();
  });

  it('hands the counted holding to the decision, with bigint storage as a number', async () => {
    const { repository } = repositoryWith({
      openIntents: 2,
      issuedInWindow: 7,
      storedBytes: 4_096n,
    });
    const decide = jest.fn(() => ({ kind: 'within' }) as const);

    await repository.createIntentWithinCeiling({ intent, decide });

    expect(decide).toHaveBeenCalledWith({
      openIntents: 2,
      issuedInWindow: 7,
      storedBytes: 4_096,
    });
  });
});
