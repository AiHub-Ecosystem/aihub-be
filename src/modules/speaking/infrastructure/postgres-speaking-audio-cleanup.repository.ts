import { internalError } from '@/common/errors/app-error';
import { storeUnavailable } from '@/common/errors/upload-errors';
import type { SpeakingAudioCleanupCandidate } from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import {
  isSpeakingAudioContentType,
  isSpeakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  SpeakingAudioUploadRepositorySupport,
  requiredEnvironment,
} from './postgres-speaking-audio-upload.repository-support';

interface CleanupRow {
  readonly kind: string;
  readonly candidateId: string;
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: string;
  readonly objectKey: string;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: string;
  readonly reservationId: string | null;
  readonly lastCleanedAt: Date | null;
}

export class PostgresSpeakingAudioCleanupRepository extends SpeakingAudioUploadRepositorySupport {
  async listDurableCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioCleanupCandidate[]> {
    const rows = await this.run(() =>
      this.client.$queryRawUnsafe<readonly CleanupRow[]>(
        `WITH candidates AS (
          SELECT 'intent'::text AS kind, id AS candidate_id, id AS asset_id,
                 organization_id, end_user_id, environment, object_key,
                 content_type, byte_size,
                 date_trunc('milliseconds', created_at) AS created_at,
                 expires_at, status, NULL::text AS reservation_id,
                 NULL::timestamptz AS last_cleaned_at
          FROM speaking_audio_upload_intents i
          WHERE (status = 'rejected' OR
                 (status = 'open' AND expires_at <= $1))
            AND (cleanup_claim_expires_at IS NULL OR
                 cleanup_claim_expires_at <= clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM speaking_audio_publication_reservations r
              WHERE r.asset_id = i.id AND r.organization_id = i.organization_id
                AND r.status = 'active' AND r.expires_at > clock_timestamp()
            )
            AND NOT EXISTS (
              SELECT 1 FROM speaking_audio_assets a
              WHERE a.id = i.id AND a.object_key = i.object_key
            )
          UNION ALL
          SELECT 'reservation'::text, id, asset_id, organization_id,
                 end_user_id, environment, object_key, NULL::text, NULL::integer,
                 date_trunc('milliseconds', created_at), expires_at,
                 status, id, last_cleaned_at
          FROM speaking_audio_publication_reservations r
          WHERE status IN ('active', 'abandoned') AND expires_at <= $1
            AND expires_at <= clock_timestamp()
            AND EXISTS (
              SELECT 1 FROM speaking_audio_publication_protocol
              WHERE id = true AND activated_at IS NOT NULL
            )
            AND (last_cleaned_at IS NULL OR last_cleaned_at <= $1)
            AND (cleanup_claim_expires_at IS NULL OR
                 cleanup_claim_expires_at <= clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM speaking_audio_assets a
              WHERE a.id = r.asset_id AND a.object_key = r.object_key
            )
        )
        SELECT kind, candidate_id AS "candidateId", asset_id AS "assetId",
               organization_id AS "organizationId", end_user_id AS "endUserId",
               environment, object_key AS "objectKey", content_type AS "contentType",
               byte_size AS "byteSize", created_at AS "createdAt",
               expires_at AS "expiresAt", status,
               reservation_id AS "reservationId",
               last_cleaned_at AS "lastCleanedAt"
        FROM candidates
        WHERE ($2::timestamptz IS NULL OR
               (created_at, candidate_id) > ($2, $3::text))
        ORDER BY created_at, candidate_id
        LIMIT $4`,
        input.expiredBefore,
        input.after?.createdAt ?? null,
        input.after?.assetId ?? null,
        input.limit,
      ),
    );
    return rows.map((row) => {
      if (
        (row.kind !== 'intent' && row.kind !== 'reservation') ||
        !isSpeakingAudioObjectKey(row.objectKey) ||
        (row.kind === 'intent' &&
          (row.contentType === null ||
            !isSpeakingAudioContentType(row.contentType) ||
            row.byteSize === null)) ||
        (row.status !== 'open' &&
          row.status !== 'rejected' &&
          row.status !== 'active' &&
          row.status !== 'abandoned')
      ) {
        throw storeUnavailable(
          'INTERNAL_ERROR',
          'Speaking Audio store is unavailable',
          false,
          internalError('Speaking Audio cleanup candidate is invalid'),
        );
      }
      return {
        kind: row.kind,
        candidateId: row.candidateId,
        assetId: row.assetId,
        organizationId: row.organizationId,
        endUserId: row.endUserId,
        environment: requiredEnvironment(row.environment),
        objectKey: row.objectKey,
        ...(row.contentType === null ||
        !isSpeakingAudioContentType(row.contentType)
          ? {}
          : { contentType: row.contentType }),
        ...(row.byteSize === null ? {} : { byteSize: row.byteSize }),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        status: row.status,
        ...(row.reservationId === null
          ? {}
          : { reservationId: row.reservationId }),
        ...(row.lastCleanedAt === null
          ? {}
          : { lastCleanedAt: row.lastCleanedAt }),
      };
    });
  }

  async claimDurableCleanupCandidate(input: {
    readonly candidate: SpeakingAudioCleanupCandidate;
    readonly orphanBefore: Date;
    readonly claimId: string;
    readonly leaseMs: number;
  }): Promise<boolean> {
    const { candidate } = input;
    return this.transaction(candidate.organizationId, async (client) => {
      if (candidate.kind === 'intent') {
        const claimed = await client.$executeRawUnsafe(
          `UPDATE speaking_audio_upload_intents i
           SET cleanup_claim_id = $8,
               cleanup_claim_expires_at =
                 clock_timestamp() + ($9 * interval '1 millisecond')
           WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
             AND environment = $4 AND object_key = $5 AND status = $6
             AND ((status = 'rejected') OR
                  (status = 'open' AND expires_at <= $7))
             AND (cleanup_claim_expires_at IS NULL OR
                  cleanup_claim_expires_at <= clock_timestamp())
             AND NOT EXISTS (
               SELECT 1 FROM speaking_audio_publication_reservations r
               WHERE r.asset_id = i.id AND r.organization_id = i.organization_id
                 AND r.status = 'active' AND r.expires_at > clock_timestamp()
             )
             AND NOT EXISTS (
               SELECT 1 FROM speaking_audio_assets a
               WHERE a.id = i.id AND a.object_key = i.object_key
             )`,
          candidate.assetId,
          candidate.organizationId,
          candidate.endUserId,
          candidate.environment,
          candidate.objectKey,
          candidate.status,
          input.orphanBefore,
          input.claimId,
          input.leaseMs,
        );
        return claimed === 1;
      }
      const claimed = await client.$executeRawUnsafe(
        `UPDATE speaking_audio_publication_reservations r
         SET status = 'abandoned', cleanup_claim_id = $7,
             cleanup_claim_expires_at =
               clock_timestamp() + ($8 * interval '1 millisecond')
         WHERE id = $1 AND asset_id = $2 AND organization_id = $3
           AND end_user_id = $4 AND environment = $5 AND object_key = $6
           AND status IN ('active', 'abandoned') AND expires_at <= $9
           AND expires_at <= clock_timestamp()
           AND EXISTS (
             SELECT 1 FROM speaking_audio_publication_protocol
             WHERE id = true AND activated_at IS NOT NULL
           )
           AND (last_cleaned_at IS NULL OR last_cleaned_at <= $9)
           AND (cleanup_claim_expires_at IS NULL OR
                cleanup_claim_expires_at <= clock_timestamp())
           AND NOT EXISTS (
             SELECT 1 FROM speaking_audio_assets a
             WHERE a.id = r.asset_id AND a.object_key = r.object_key
           )`,
        candidate.reservationId,
        candidate.assetId,
        candidate.organizationId,
        candidate.endUserId,
        candidate.environment,
        candidate.objectKey,
        input.claimId,
        input.leaseMs,
        input.orphanBefore,
      );
      return claimed === 1;
    });
  }

  async removeDurableCleanupCandidate(input: {
    readonly candidate: SpeakingAudioCleanupCandidate;
    readonly expiredBefore: Date;
    readonly claimId: string;
  }): Promise<boolean> {
    const { candidate } = input;
    return this.transaction(candidate.organizationId, async (client) => {
      if (candidate.kind === 'intent') {
        const removed = await client.$executeRawUnsafe(
          `DELETE FROM speaking_audio_upload_intents i
           WHERE id = $1 AND organization_id = $2 AND end_user_id = $3
             AND environment = $4 AND object_key = $5 AND status = $6
             AND cleanup_claim_id = $7
             AND cleanup_claim_expires_at > clock_timestamp()
             AND ((status = 'rejected') OR
                  (status = 'open' AND expires_at <= $8))
             AND NOT EXISTS (
               SELECT 1 FROM speaking_audio_publication_reservations r
               WHERE r.asset_id = i.id AND r.organization_id = i.organization_id
                 AND r.status = 'active' AND r.expires_at > clock_timestamp()
             )
             AND NOT EXISTS (
               SELECT 1 FROM speaking_audio_assets a
               WHERE a.id = i.id AND a.object_key = i.object_key
             )`,
          candidate.assetId,
          candidate.organizationId,
          candidate.endUserId,
          candidate.environment,
          candidate.objectKey,
          candidate.status,
          input.claimId,
          input.expiredBefore,
        );
        return removed === 1;
      }
      if (candidate.lastCleanedAt !== undefined) {
        const removed = await client.$executeRawUnsafe(
          `DELETE FROM speaking_audio_publication_reservations
           WHERE id = $1 AND asset_id = $2 AND organization_id = $3
             AND end_user_id = $4 AND environment = $5 AND object_key = $6
             AND status = 'abandoned' AND cleanup_claim_id = $7
             AND cleanup_claim_expires_at > clock_timestamp()
             AND expires_at <= $8 AND last_cleaned_at <= $8
             AND NOT EXISTS (
               SELECT 1 FROM speaking_audio_assets a
               WHERE a.id = speaking_audio_publication_reservations.asset_id
                 AND a.object_key = speaking_audio_publication_reservations.object_key
             )`,
          candidate.reservationId,
          candidate.assetId,
          candidate.organizationId,
          candidate.endUserId,
          candidate.environment,
          candidate.objectKey,
          input.claimId,
          input.expiredBefore,
        );
        return removed === 1;
      }
      const released = await client.$executeRawUnsafe(
        `UPDATE speaking_audio_publication_reservations
         SET last_cleaned_at = clock_timestamp(), cleanup_claim_id = NULL,
             cleanup_claim_expires_at = NULL
         WHERE id = $1 AND asset_id = $2 AND organization_id = $3
           AND end_user_id = $4 AND environment = $5 AND object_key = $6
           AND status = 'abandoned' AND cleanup_claim_id = $7
           AND cleanup_claim_expires_at > clock_timestamp()
           AND expires_at <= $8`,
        candidate.reservationId,
        candidate.assetId,
        candidate.organizationId,
        candidate.endUserId,
        candidate.environment,
        candidate.objectKey,
        input.claimId,
        input.expiredBefore,
      );
      return released === 1;
    });
  }
}
