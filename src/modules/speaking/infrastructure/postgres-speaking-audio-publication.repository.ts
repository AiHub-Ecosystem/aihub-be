import { randomUUID } from 'node:crypto';

import type {
  SpeakingAudioPublicationReservation,
  SpeakingAudioPublicationResult,
  SpeakingAudioUploadOwner,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import type { SpeakingAudioAsset } from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioUploadIntent as IntentModel,
  Prisma,
} from '@prisma-client/client';
import {
  LOCK_INTENT_SQL,
  LOCK_PUBLICATION_PROTOCOL_SQL,
  SpeakingAudioUploadRepositorySupport,
  mapIntent,
  ownerWhere,
} from './postgres-speaking-audio-upload.repository-support';

export class PostgresSpeakingAudioPublicationRepository extends SpeakingAudioUploadRepositorySupport {
  async claimRefusal(
    owner: SpeakingAudioUploadOwner,
    reservationId?: string,
  ): Promise<boolean> {
    return this.transaction(owner.organizationId, async (client) => {
      // arch-check: fixed parameterized intent-lock SQL is owned by support
      const [intent] = await client.$queryRawUnsafe<readonly IntentModel[]>(
        LOCK_INTENT_SQL,
        owner.assetId,
        owner.organizationId,
        owner.endUserId,
        owner.environment,
      );
      if (intent === undefined) return false;
      if (reservationId === undefined) {
        const [live] = await client.$queryRawUnsafe<readonly { id: string }[]>(
          `SELECT id FROM speaking_audio_publication_reservations
           WHERE asset_id = $1 AND organization_id = $2 AND end_user_id = $3
             AND environment = $4 AND status = 'active'
             AND expires_at > clock_timestamp() LIMIT 1`,
          owner.assetId,
          owner.organizationId,
          owner.endUserId,
          owner.environment,
        );
        if (live !== undefined) return false;
      } else {
        await this.lockReservation(client, owner, reservationId);
        const abandoned = await client.$executeRawUnsafe(
          `UPDATE speaking_audio_publication_reservations
           SET status = 'abandoned'
           WHERE id = $1 AND asset_id = $2 AND organization_id = $3
             AND end_user_id = $4 AND environment = $5 AND status = 'active'
             AND expires_at > clock_timestamp()`,
          reservationId,
          owner.assetId,
          owner.organizationId,
          owner.endUserId,
          owner.environment,
        );
        if (abandoned !== 1) return false;
      }
      const rejected = await client.$executeRawUnsafe(
        `UPDATE speaking_audio_upload_intents SET status = 'rejected'
         WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
           AND environment = $4 AND (status = 'rejected' OR
             (status = 'open' AND expires_at > clock_timestamp()))`,
        owner.assetId,
        owner.organizationId,
        owner.endUserId,
        owner.environment,
      );
      return rejected === 1;
    });
  }

  async beginPublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
    readonly reservationTtlMs: number;
  }): Promise<
    | SpeakingAudioPublicationReservation
    | 'disabled'
    | 'published'
    | 'in_progress'
    | 'missing'
  > {
    return this.transaction(input.owner.organizationId, async (client) => {
      // arch-check: fixed parameterized protocol-lock SQL is owned by support
      const [protocol] = await client.$queryRawUnsafe<
        readonly { active: boolean }[]
      >(LOCK_PUBLICATION_PROTOCOL_SQL);
      if (protocol?.active !== true) return 'disabled';

      // arch-check: fixed parameterized intent-lock SQL is owned by support
      const [intentRow] = await client.$queryRawUnsafe<readonly IntentModel[]>(
        LOCK_INTENT_SQL,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      );
      if (intentRow === undefined) {
        return (await this.findAsset(client, input.owner)) === undefined
          ? 'missing'
          : 'published';
      }
      const intent = mapIntent(intentRow);
      if (
        intent === undefined ||
        intent.status !== 'open' ||
        intent.expiresAt.getTime() <= input.now.getTime()
      ) {
        return 'missing';
      }
      const [unexpired] = await client.$queryRawUnsafe<
        readonly { active: boolean }[]
      >(
        `SELECT expires_at > clock_timestamp() AS active
         FROM speaking_audio_upload_intents WHERE id = $1 AND organization_id = $2`,
        input.owner.assetId,
        input.owner.organizationId,
      );
      if (unexpired?.active !== true) return 'missing';

      const [live] = await client.$queryRawUnsafe<readonly { id: string }[]>(
        `SELECT id FROM speaking_audio_publication_reservations
         WHERE asset_id = $1 AND organization_id = $2 AND end_user_id = $3
           AND environment = $4 AND status = 'active'
           AND expires_at > clock_timestamp()
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      );
      if (live !== undefined) return 'in_progress';

      await client.$executeRawUnsafe(
        `UPDATE speaking_audio_publication_reservations
         SET status = 'abandoned'
         WHERE asset_id = $1 AND organization_id = $2 AND end_user_id = $3
           AND environment = $4 AND status = 'active'
           AND expires_at <= clock_timestamp()`,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      );

      const reservationId = `pub_${randomUUID()}`;
      const objectKey =
        `orgs/${input.owner.organizationId}/speaking/${input.owner.assetId}` +
        `/publication/${reservationId}`;
      await client.$executeRawUnsafe(
        `INSERT INTO speaking_audio_publication_reservations
           (id, asset_id, organization_id, end_user_id, environment,
            object_key, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(),
                 clock_timestamp() + ($7 * interval '1 millisecond'))`,
        reservationId,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
        objectKey,
        input.reservationTtlMs,
      );
      return { reservationId, objectKey };
    });
  }

  async finalizePublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly reservationId: string;
    readonly acceptedAt: Date;
    readonly retentionExpiresAt: Date;
  }): Promise<SpeakingAudioPublicationResult | undefined> {
    return this.completionTransaction(
      input.owner.organizationId,
      async (client) => {
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
        const intent = mapIntent(intentRow);
        if (intent === undefined) {
          const existing = await this.findAsset(client, input.owner);
          return existing === undefined
            ? undefined
            : { asset: existing, created: false };
        }
        if (intent.status !== 'open') return undefined;
        await this.lockReservation(client, input.owner, input.reservationId);
        const [reservation] = await client.$queryRawUnsafe<
          readonly { objectKey: string }[]
        >(
          `DELETE FROM speaking_audio_publication_reservations r
           WHERE id = $1 AND asset_id = $2 AND organization_id = $3
             AND end_user_id = $4 AND environment = $5 AND status = 'active'
             AND expires_at > clock_timestamp()
             AND EXISTS (
               SELECT 1 FROM speaking_audio_upload_intents i
               WHERE i.id = $2 AND i.organization_id = $3
                 AND i.status = 'open' AND i.expires_at > clock_timestamp()
             )
           RETURNING object_key AS "objectKey"`,
          input.reservationId,
          input.owner.assetId,
          input.owner.organizationId,
          input.owner.endUserId,
          input.owner.environment,
        );
        if (reservation === undefined) return undefined;

        const asset: SpeakingAudioAsset = {
          assetId: intent.assetId,
          organizationId: intent.organizationId,
          endUserId: intent.endUserId,
          environment: intent.environment,
          objectKey: reservation.objectKey,
          contentType: intent.contentType,
          byteSize: intent.byteSize,
          acceptedAt: input.acceptedAt,
          retentionExpiresAt: input.retentionExpiresAt,
        };
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
        await client.speakingAudioUploadIntent.delete({
          where: ownerWhere(input.owner),
        });
        return { asset, created: true };
      },
    );
  }

  async releasePublication(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly reservationId: string;
  }): Promise<void> {
    await this.transaction(input.owner.organizationId, (client) =>
      client.$executeRawUnsafe(
        `UPDATE speaking_audio_publication_reservations
         SET status = 'abandoned'
         WHERE id = $1 AND asset_id = $2 AND organization_id = $3
           AND end_user_id = $4 AND environment = $5 AND status = 'active'`,
        input.reservationId,
        input.owner.assetId,
        input.owner.organizationId,
        input.owner.endUserId,
        input.owner.environment,
      ),
    );
  }

  private async lockReservation(
    client: Prisma.TransactionClient,
    owner: SpeakingAudioUploadOwner,
    reservationId: string,
  ): Promise<void> {
    await client.$queryRawUnsafe(
      `SELECT id FROM speaking_audio_publication_reservations
       WHERE id = $1 AND asset_id = $2 AND organization_id = $3
         AND end_user_id = $4 AND environment = $5
       FOR UPDATE`,
      reservationId,
      owner.assetId,
      owner.organizationId,
      owner.endUserId,
      owner.environment,
    );
  }
}
