import { AppError, internalError } from '@/common/errors/app-error';
import { storeUnavailable } from '@/common/errors/upload-errors';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import {
  SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS,
  SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
} from '@/modules/speaking/application/speaking-audio-completion-timeouts';
import type {
  SpeakingAudioCeilingDecision,
  SpeakingAudioOrganizationHolding,
} from '@/modules/speaking/application/speaking-audio-org-ceiling.policy';
import { SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS } from '@/modules/speaking/application/speaking-audio-org-ceiling.policy';
import type {
  SpeakingAudioUploadLookup,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type {
  SpeakingAudioAsset,
  SpeakingAudioEnvironment,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { isSpeakingAudioContentType } from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioAsset as AssetModel,
  SpeakingAudioUploadIntent as IntentModel,
  Prisma,
  PrismaClient,
} from '@prisma-client/client';

export { createSpeakingAudioQueryClient } from './postgres-speaking-audio-upload.fixture-client';

function requiredEnvironment(value: string): SpeakingAudioEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio environment is invalid'),
    );
  }
  return value;
}

function mapIntent(
  row: IntentModel | undefined,
): SpeakingAudioUploadIntent | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (
    !isSpeakingAudioContentType(row.contentType) ||
    (row.status !== 'open' && row.status !== 'rejected')
  ) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio intent is invalid'),
    );
  }
  return {
    assetId: row.id,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: requiredEnvironment(row.environment),
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

function mapAsset(row: AssetModel | undefined): SpeakingAudioAsset | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (!isSpeakingAudioContentType(row.contentType)) {
    throw storeUnavailable(
      'INTERNAL_ERROR',
      'Speaking Audio store is unavailable',
      false,
      internalError('Speaking Audio asset is invalid'),
    );
  }
  return {
    assetId: row.id,
    organizationId: row.organizationId,
    endUserId: row.endUserId,
    environment: requiredEnvironment(row.environment),
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    acceptedAt: row.acceptedAt,
    retentionExpiresAt: row.retentionExpiresAt,
  };
}

function intentData(intent: SpeakingAudioUploadIntent) {
  return {
    id: intent.assetId,
    organizationId: intent.organizationId,
    endUserId: intent.endUserId,
    environment: intent.environment,
    objectKey: intent.objectKey,
    contentType: intent.contentType,
    byteSize: intent.byteSize,
    status: 'open',
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
  };
}

function ownerWhere(owner: SpeakingAudioUploadOwner) {
  return {
    id: owner.assetId,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
  };
}

/**
 * The one row lock in this repository stays SQL: Prisma has no `FOR UPDATE`.
 * Columns are aliased to the model's field names so the row maps like any other.
 */
const LOCK_INTENT_SQL = `
  SELECT
    id,
    organization_id AS "organizationId",
    end_user_id AS "endUserId",
    environment,
    object_key AS "objectKey",
    content_type AS "contentType",
    byte_size AS "byteSize",
    status,
    created_at AS "createdAt",
    expires_at AS "expiresAt"
  FROM speaking_audio_upload_intents
  WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
    AND environment = $4
  FOR UPDATE
`;

const SET_COMPLETION_IDLE_TIMEOUT_SQL = `
  SELECT set_config('idle_in_transaction_session_timeout', $1, true)
`;

const ORG_CEILING_LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/**
 * Intents still open and unexpired, intents created in the issuance window,
 * and the bytes the Organization already stores: completed assets plus what an
 * open intent may still turn into (#374).
 */
const HOLDING_SQL = `
  SELECT
    (SELECT count(*)::int FROM speaking_audio_upload_intents
      WHERE organization_id = $1 AND status = 'open' AND expires_at > $2)
      AS "openIntents",
    (SELECT count(*)::int FROM speaking_audio_upload_intents
      WHERE organization_id = $1 AND created_at > $3)
      AS "issuedInWindow",
    (SELECT coalesce(sum(byte_size), 0)::bigint FROM speaking_audio_assets
      WHERE organization_id = $1)
    + (SELECT coalesce(sum(byte_size), 0)::bigint FROM speaking_audio_upload_intents
      WHERE organization_id = $1 AND status = 'open' AND expires_at > $2)
      AS "storedBytes"
`;

interface HoldingRow {
  readonly openIntents: number;
  readonly issuedInWindow: number;
  readonly storedBytes: bigint | number | string;
}

function organizationCeilingLockKey(organizationId: string): string {
  return `${organizationId}:speaking-audio:intents`;
}

export class PostgresSpeakingAudioUploadRepository
  implements SpeakingAudioUploadRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    await this.run(() =>
      this.client.speakingAudioUploadIntent.create({
        data: intentData(intent),
      }),
    );
  }

  async createIntentWithinCeiling(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly decide: (
      holding: SpeakingAudioOrganizationHolding,
    ) => SpeakingAudioCeilingDecision;
  }): Promise<SpeakingAudioCeilingDecision> {
    const { intent } = input;
    return this.transaction(async (client) => {
      await client.$queryRawUnsafe(
        ORG_CEILING_LOCK_SQL,
        organizationCeilingLockKey(intent.organizationId),
      );
      const [row] = await client.$queryRawUnsafe<readonly HoldingRow[]>(
        HOLDING_SQL,
        intent.organizationId,
        intent.createdAt,
        new Date(
          intent.createdAt.getTime() - SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS,
        ),
      );
      const decision = input.decide({
        openIntents: Number(row?.openIntents ?? 0),
        issuedInWindow: Number(row?.issuedInWindow ?? 0),
        storedBytes: Number(row?.storedBytes ?? 0),
      });
      if (decision.kind === 'refused') return decision;

      await client.speakingAudioUploadIntent.create({
        data: intentData(intent),
      });
      return decision;
    });
  }

  async findUpload(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioUploadLookup> {
    const intent = mapIntent(
      (await this.run(() =>
        this.client.speakingAudioUploadIntent.findFirst({
          where: ownerWhere(owner),
        }),
      )) ?? undefined,
    );
    if (intent !== undefined) {
      return { kind: 'intent', intent };
    }

    const asset = await this.findAsset(this.client, owner);
    return asset === undefined ? { kind: 'missing' } : { kind: 'asset', asset };
  }

  async confirmRefreshableIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean> {
    const matching = await this.run(() =>
      this.client.speakingAudioUploadIntent.count({
        where: {
          ...ownerWhere(input.owner),
          status: 'open',
          expiresAt: { gt: input.now },
        },
      }),
    );
    return matching === 1;
  }

  async removeRejectedIntent(owner: SpeakingAudioUploadOwner): Promise<void> {
    await this.run(() =>
      this.client.speakingAudioUploadIntent.deleteMany({
        where: { ...ownerWhere(owner), status: 'rejected' },
      }),
    );
  }

  async completeIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: () => Date;
    readonly prepare: (
      intent: SpeakingAudioUploadIntent,
    ) => Promise<
      | { readonly kind: 'accepted'; readonly asset: SpeakingAudioAsset }
      | { readonly kind: 'refused'; readonly refusal: AppError }
    >;
  }): Promise<
    | { readonly kind: 'created'; readonly asset: SpeakingAudioAsset }
    | {
        readonly kind: 'already_completed';
        readonly asset: SpeakingAudioAsset;
      }
    | { readonly kind: 'missing' }
    | { readonly kind: 'refused'; readonly refusal: AppError }
  > {
    return this.completionTransaction(async (client) => {
      await client.$queryRawUnsafe<readonly { set_config: string }[]>(
        SET_COMPLETION_IDLE_TIMEOUT_SQL,
        String(SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS),
      );
      const [intentRow] = await client.$queryRawUnsafe<readonly IntentModel[]>(
        LOCK_INTENT_SQL,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      );

      if (intentRow === undefined) {
        const asset = await this.findAsset(client, input.owner);
        return asset === undefined
          ? { kind: 'missing' }
          : { kind: 'already_completed', asset };
      }

      const intent = mapIntent(intentRow);
      if (
        intent === undefined ||
        intent.status !== 'open' ||
        intent.expiresAt.getTime() <= input.now().getTime()
      ) {
        return { kind: 'missing' };
      }
      const prepared = await input.prepare(intent);
      if (prepared.kind === 'refused') {
        const rejected = await client.speakingAudioUploadIntent.updateMany({
          where: {
            ...ownerWhere(input.owner),
            status: 'open',
            expiresAt: { gt: input.now() },
          },
          data: { status: 'rejected' },
        });
        return rejected.count === 1
          ? { kind: 'refused', refusal: prepared.refusal }
          : { kind: 'missing' };
      }
      if (intent.expiresAt.getTime() <= input.now().getTime()) {
        return { kind: 'missing' };
      }
      const { asset } = prepared;
      if (
        asset.assetId !== intent.assetId ||
        asset.organizationId !== intent.organizationId ||
        asset.endUserId !== intent.endUserId ||
        asset.environment !== intent.environment ||
        asset.objectKey !== intent.objectKey ||
        asset.contentType !== intent.contentType ||
        asset.byteSize !== intent.byteSize
      ) {
        throw storeUnavailable(
          'INTERNAL_ERROR',
          'Speaking Audio store is unavailable',
          false,
          internalError('Speaking Audio intent changed'),
        );
      }

      await client.speakingAudioAsset.create({
        data: {
          id: asset.assetId,
          organizationId: asset.organizationId,
          endUserId: asset.endUserId,
          environment: asset.environment,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          acceptedAt: asset.acceptedAt,
          retentionExpiresAt: asset.retentionExpiresAt,
        },
      });
      const removed = await client.speakingAudioUploadIntent.deleteMany({
        where: { ...ownerWhere(input.owner), status: 'open' },
      });
      if (removed.count !== 1) {
        throw storeUnavailable(
          'INTERNAL_ERROR',
          'Speaking Audio store is unavailable',
          false,
          internalError('Speaking Audio intent changed'),
        );
      }
      return { kind: 'created', asset };
    });
  }

  async listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioUploadIntent[]> {
    const { after } = input;
    const rows = await this.run(() =>
      this.client.speakingAudioUploadIntent.findMany({
        where: {
          AND: [
            {
              OR: [
                { status: 'rejected' },
                { status: 'open', expiresAt: { lte: input.expiredBefore } },
              ],
            },
            // `(created_at, id) > ($after.createdAt, $after.assetId)`
            ...(after === undefined
              ? []
              : [
                  {
                    OR: [
                      { createdAt: { gt: after.createdAt } },
                      {
                        createdAt: after.createdAt,
                        id: { gt: after.assetId },
                      },
                    ],
                  },
                ]),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
      }),
    );
    return rows.flatMap((row) => {
      const intent = mapIntent(row);
      return intent === undefined ? [] : [intent];
    });
  }

  async removeCleanupCandidate(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly expiredBefore: Date;
  }): Promise<boolean> {
    const { intent } = input;
    const removed = await this.run(() =>
      this.client.speakingAudioUploadIntent.deleteMany({
        where: {
          id: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          objectKey: intent.objectKey,
          status: intent.status,
          // A rejected intent is removable at once; an open one only after expiry.
          ...(intent.status === 'rejected'
            ? {}
            : { expiresAt: { lte: input.expiredBefore } }),
        },
      }),
    );
    return removed.count === 1;
  }

  private async findAsset(
    client: Pick<Prisma.TransactionClient, 'speakingAudioAsset'>,
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioAsset | undefined> {
    return mapAsset(
      (await this.run(() =>
        client.speakingAudioAsset.findFirst({ where: ownerWhere(owner) }),
      )) ?? undefined,
    );
  }

  private async transaction<T>(
    run: (client: Prisma.TransactionClient) => Promise<T>,
    options: {
      readonly maxWait: number;
      readonly timeout: number;
    } = CONTROL_PLANE_TRANSACTION_OPTIONS,
  ): Promise<T> {
    try {
      return await this.client.$transaction((client) => run(client), options);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Speaking Audio store is unavailable',
        false,
        error,
      );
    }
  }

  private async completionTransaction<T>(
    run: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(run, {
      ...CONTROL_PLANE_TRANSACTION_OPTIONS,
      timeout: SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
    });
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw storeUnavailable(
        'INTERNAL_ERROR',
        'Speaking Audio store is unavailable',
        false,
        error,
      );
    }
  }
}
