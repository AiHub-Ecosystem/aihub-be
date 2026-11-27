import { internalError } from '@/common/errors/app-error';
import { storeUnavailable } from '@/common/errors/upload-errors';
import { SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS } from '@/modules/speaking/application/audio/speaking-audio-completion-timeouts';
import {
  SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS,
  type SpeakingAudioCeilingDecision,
  type SpeakingAudioOrganizationHolding,
} from '@/modules/speaking/application/audio/speaking-audio-org-ceiling.policy';
import type {
  CompleteSpeakingAudioUploadIntentInput,
  CompleteSpeakingAudioUploadIntentResult,
  SpeakingAudioCleanupCandidate,
  SpeakingAudioUploadLookup,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import type { SpeakingAudioUploadIntent } from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioUploadIntent as IntentModel,
  PrismaClient,
} from '@prisma-client/client';
import { PostgresSpeakingAudioCleanupRepository } from './postgres-speaking-audio-cleanup.repository';
import { PostgresSpeakingAudioPublicationRepository } from './postgres-speaking-audio-publication.repository';
import {
  LOCK_INTENT_SQL,
  LOCK_PUBLICATION_PROTOCOL_SQL,
  SpeakingAudioUploadRepositorySupport,
  mapIntent,
  ownerWhere,
} from './postgres-speaking-audio-upload.repository-support';

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

const SET_COMPLETION_IDLE_TIMEOUT_SQL = `
  SELECT set_config('idle_in_transaction_session_timeout', $1, true)
`;

const ORG_CEILING_LOCK_SQL = `
  WITH locked AS MATERIALIZED (
    SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
  )
  SELECT 1 FROM locked
`;

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
  extends SpeakingAudioUploadRepositorySupport
  implements SpeakingAudioUploadRepositoryPort
{
  private readonly publication: PostgresSpeakingAudioPublicationRepository;
  private readonly cleanup: PostgresSpeakingAudioCleanupRepository;

  constructor(client: PrismaClient) {
    super(client);
    this.publication = new PostgresSpeakingAudioPublicationRepository(client);
    this.cleanup = new PostgresSpeakingAudioCleanupRepository(client);
  }

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    await this.transaction(intent.organizationId, (client) =>
      client.speakingAudioUploadIntent.create({
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
    return this.transaction(intent.organizationId, async (client) => {
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
    return this.transaction(owner.organizationId, async (client) => {
      const intent = mapIntent(
        (await client.speakingAudioUploadIntent.findFirst({
          where: ownerWhere(owner),
        })) ?? undefined,
      );
      if (intent !== undefined) {
        return { kind: 'intent', intent } as const;
      }

      const asset = await this.findAsset(client, owner);
      return asset === undefined
        ? ({ kind: 'missing' } as const)
        : ({ kind: 'asset', asset } as const);
    });
  }

  async confirmRefreshableIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean> {
    const matching = await this.transaction(
      input.owner.organizationId,
      (client) =>
        client.speakingAudioUploadIntent.count({
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
    await this.transaction(owner.organizationId, (client) =>
      client.speakingAudioUploadIntent.deleteMany({
        where: { ...ownerWhere(owner), status: 'rejected' },
      }),
    );
  }

  async completeIntent(
    input: CompleteSpeakingAudioUploadIntentInput,
  ): Promise<CompleteSpeakingAudioUploadIntentResult> {
    return this.completionTransaction(
      input.owner.organizationId,
      async (client) => {
        await client.$queryRawUnsafe<readonly { set_config: string }[]>(
          SET_COMPLETION_IDLE_TIMEOUT_SQL,
          String(SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS),
        );
        // arch-check: fixed parameterized protocol-lock SQL is owned by support
        const [protocol] = await client.$queryRawUnsafe<
          readonly { active: boolean }[]
        >(LOCK_PUBLICATION_PROTOCOL_SQL);
        if (input.legacyPublication === true && protocol?.active === true) {
          return { kind: 'protocol_enabled' };
        }
        // arch-check: fixed parameterized intent-lock SQL is owned by support
        const [intentRow] = await client.$queryRawUnsafe<
          readonly IntentModel[]
        >(
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
      },
    );
  }

  beginPublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
    readonly reservationTtlMs: number;
  }): ReturnType<
    PostgresSpeakingAudioPublicationRepository['beginPublication']
  > {
    return this.publication.beginPublication(input);
  }

  finalizePublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly reservationId: string;
    readonly acceptedAt: Date;
    readonly retentionExpiresAt: Date;
  }): ReturnType<
    PostgresSpeakingAudioPublicationRepository['finalizePublication']
  > {
    return this.publication.finalizePublication(input);
  }

  releasePublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly reservationId: string;
  }): Promise<void> {
    return this.publication.releasePublication(input);
  }

  claimRefusal(
    owner: SpeakingAudioUploadOwner,
    reservationId?: string,
  ): Promise<boolean> {
    return this.publication.claimRefusal(owner, reservationId);
  }

  async listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioUploadIntent[]> {
    const { after } = input;
    const cursor =
      after === undefined
        ? {}
        : {
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.assetId } },
            ],
          };
    const rows = await this.run(() =>
      this.client.speakingAudioUploadIntent.findMany({
        where: {
          ...cursor,
          AND: [
            {
              OR: [
                { status: 'rejected' },
                { status: 'open', expiresAt: { lte: input.expiredBefore } },
              ],
            },
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
    const removed = await this.run(() =>
      this.client.speakingAudioUploadIntent.deleteMany({
        where: {
          id: input.intent.assetId,
          organizationId: input.intent.organizationId,
          endUserId: input.intent.endUserId,
          environment: input.intent.environment,
          objectKey: input.intent.objectKey,
          status: input.intent.status,
          ...(input.intent.status === 'rejected'
            ? {}
            : { expiresAt: { lte: input.expiredBefore } }),
        },
      }),
    );
    return removed.count === 1;
  }

  listDurableCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioCleanupCandidate[]> {
    return this.cleanup.listDurableCleanupCandidates(input);
  }

  claimDurableCleanupCandidate(input: {
    readonly candidate: SpeakingAudioCleanupCandidate;
    readonly orphanBefore: Date;
    readonly claimId: string;
    readonly leaseMs: number;
  }): Promise<boolean> {
    return this.cleanup.claimDurableCleanupCandidate(input);
  }

  removeDurableCleanupCandidate(input: {
    readonly candidate: SpeakingAudioCleanupCandidate;
    readonly expiredBefore: Date;
    readonly claimId: string;
  }): Promise<boolean> {
    return this.cleanup.removeDurableCleanupCandidate(input);
  }
}
