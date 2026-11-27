import type { RequestContext } from '@/common/request-context/request-context';
import { UploadSessionVerificationRefusal } from '@/modules/uploads/application/upload-session.errors';
import type { UploadSessionPolicy } from '@/modules/uploads/application/upload-session.policy';
import type {
  UploadSessionGrant,
  UploadSessionRepositoryPort,
  UploadSessionServicePort,
  UploadSessionStoragePort,
} from '@/modules/uploads/application/upload-session.port';
import type { UploadSessionVerificationPort } from '@/modules/uploads/application/upload-session.verification';
import type {
  PublishedUploadSession,
  UploadSessionEnvironment,
  UploadSessionIntent,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

export class UploadSessionService<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
  P extends PublishedUploadSession<C, E> = PublishedUploadSession<C, E>,
> implements UploadSessionServicePort<C, E, P>
{
  constructor(
    private readonly repository: UploadSessionRepositoryPort<C, E, P>,
    private readonly storage: UploadSessionStoragePort<C, E>,
    private readonly policy: UploadSessionPolicy<C, E>,
    private readonly newAssetId: (createdAt: Date) => string,
    private readonly now: () => Date = () => new Date(),
    private readonly verification?: UploadSessionVerificationPort<C, E>,
  ) {}

  async create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<UploadSessionGrant<C>> {
    const { policy } = this;
    if (!policy.isContentType(input.contentType)) throw policy.invalidRequest();
    if (
      !Number.isInteger(input.byteSize) ||
      input.byteSize < (policy.minBytes ?? 1)
    ) {
      throw policy.invalidRequest();
    }
    if (input.byteSize > policy.maxBytes) throw policy.payloadTooLarge();

    const createdAt = this.now();
    const assetId = this.newAssetId(createdAt);
    const owner = policy.owner(input.context, assetId);
    const intent: UploadSessionIntent<C, E> = {
      ...owner,
      stagingKey: policy.stagingKey(owner),
      publishedKey: policy.publishedKey(owner),
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + policy.intentTtlMs),
      status: 'open',
    };
    const signed = await this.storage.createUploadUrl({
      environment: owner.environment,
      stagingKey: intent.stagingKey,
      contentType: intent.contentType,
      byteSize: intent.byteSize,
    });
    if (!(await this.repository.createIntent(intent, policy.rateWindowMs)))
      throw policy.rateLimited();

    return {
      assetId,
      contentType: intent.contentType,
      byteSize: intent.byteSize,
      uploadUrl: signed.url,
      uploadFields: signed.fields,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt: intent.expiresAt,
    };
  }

  async refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<UploadSessionGrant<C>> {
    const { policy } = this;
    if (!policy.isAssetId(input.assetId)) throw policy.invalidRequest();
    const owner = policy.owner(input.context, input.assetId);
    const found = await this.repository.findUpload(owner);
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw policy.notFound();
    }

    const signed = await this.storage.createUploadUrl({
      environment: found.intent.environment,
      stagingKey: found.intent.stagingKey,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
    });
    const stillOpen = await this.repository.findUpload(owner);
    if (
      stillOpen.kind !== 'intent' ||
      stillOpen.intent.status !== 'open' ||
      stillOpen.intent.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw policy.notFound();
    }
    return {
      assetId: found.intent.assetId,
      contentType: found.intent.contentType,
      byteSize: found.intent.byteSize,
      uploadUrl: signed.url,
      uploadFields: signed.fields,
      uploadUrlExpiresAt: signed.expiresAt,
      intentExpiresAt: found.intent.expiresAt,
    };
  }

  async complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<P> {
    const { policy } = this;
    if (!policy.isAssetId(input.assetId)) throw policy.invalidRequest();
    const owner = policy.owner(input.context, input.assetId);
    const signal =
      policy.completionSignal?.(input.context.signal) ?? input.context.signal;
    {
      const found = await this.repository.findUpload(owner);
      if (found.kind === 'asset') return found.asset;
      if (
        found.kind !== 'intent' ||
        (found.intent.status !== 'open' &&
          found.intent.status !== 'publishing') ||
        found.intent.expiresAt.getTime() <= this.now().getTime()
      ) {
        throw policy.notFound();
      }

      const verificationPort = this.verification;
      const lease = verificationPort?.reserveVerification();
      try {
        let stored;
        try {
          stored = await this.storage.inspectObject(
            {
              environment: found.intent.environment,
              stagingKey: found.intent.stagingKey,
              contentType: found.intent.contentType,
              byteSize: found.intent.byteSize,
            },
            signal,
          );
        } catch (error) {
          if (error instanceof UploadSessionVerificationRefusal) {
            await this.rejectRefused(found.intent, signal);
            throw error.refusal;
          }
          throw error;
        }
        if (stored === undefined) {
          const current = await this.repository.findUpload(owner);
          if (current.kind === 'asset') return current.asset;
          throw policy.notFound();
        }
        let bytes = stored.bytes;
        if (verificationPort !== undefined && lease !== undefined) {
          const refusal = verificationPort.invalidStoredObject?.(
            stored,
            found.intent,
          );
          const verification =
            refusal === undefined
              ? await verificationPort.verify({
                  contentType: stored.contentType ?? found.intent.contentType,
                  bytes: stored.bytes,
                  signal,
                  lease,
                })
              : undefined;
          bytes =
            verification?.kind === 'sanitized'
              ? verification.bytes
              : stored.bytes;
          if (refusal !== undefined || verification?.kind !== 'sanitized') {
            await this.rejectRefused(found.intent, signal);
            throw (
              refusal ??
              (verification?.kind === 'too_large'
                ? policy.payloadTooLarge()
                : policy.invalidRequest())
            );
          }
        }

        if (signal.aborted) throw policy.storageUnavailable();

        const publicationStartedAt = this.now();
        const reservation = await this.repository.beginPublication({
          owner,
          now: publicationStartedAt,
          rateWindowMs: policy.rateWindowMs,
        });
        if (reservation === 'published') {
          const current = await this.repository.findUpload(owner);
          if (current.kind === 'asset') return current.asset;
          throw policy.notFound();
        }
        if (reservation === 'limited') throw policy.rateLimited();
        if (reservation === 'in_progress') {
          while (policy.waitForPublication === true && !signal.aborted) {
            const current = await this.repository.findUpload(owner);
            if (current.kind === 'asset') return current.asset;
            if (current.kind === 'missing') throw policy.notFound();
            await new Promise<void>((resolve) => {
              let timer: ReturnType<typeof setTimeout>;
              const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', finish);
                resolve();
              };
              timer = setTimeout(finish, 25);
              signal.addEventListener('abort', finish, { once: true });
            });
          }
          const current = await this.repository.findUpload(owner);
          if (current.kind === 'asset') return current.asset;
          if (current.kind === 'missing') throw policy.notFound();
          throw policy.storageUnavailable(
            'Upload publication is already in progress',
          );
        }
        if (reservation === 'missing') throw policy.notFound();
        if (reservation !== 'started' && typeof reservation !== 'object')
          throw policy.notFound();
        const reservationId =
          typeof reservation === 'object'
            ? reservation.reservationId
            : undefined;
        const publishedKey =
          typeof reservation === 'object'
            ? reservation.publishedKey
            : found.intent.publishedKey;
        const imageUrl = this.storage.publicUrl({
          environment: found.intent.environment,
          publishedKey,
        });

        try {
          await this.storage.publishObject(
            {
              environment: found.intent.environment,
              stagingKey: found.intent.stagingKey,
              publishedKey,
              contentType: stored.contentType ?? found.intent.contentType,
              bytes,
              byteSize: stored.byteSize ?? found.intent.byteSize,
            },
            signal,
          );
        } catch (error) {
          if (
            error instanceof UploadSessionVerificationRefusal &&
            reservationId !== undefined
          ) {
            await this.rejectRefused(found.intent, signal, reservationId);
            throw error.refusal;
          }
          await this.repository.releasePublication(
            owner,
            publicationStartedAt,
            reservationId,
          );
          if (error instanceof UploadSessionVerificationRefusal) {
            await this.rejectRefused(found.intent, signal);
            throw error.refusal;
          }
          throw error;
        }

        let asset: P | 'revoked' | undefined;
        try {
          asset = await this.repository.markPublished({
            owner,
            now: this.now(),
            publicationStartedAt,
            imageUrl,
            requestId: input.context.requestId,
            contentType: stored.contentType ?? found.intent.contentType,
            byteSize: stored.byteSize ?? found.intent.byteSize,
            ...(reservationId === undefined ? {} : { reservationId }),
          });
        } catch (error) {
          await this.releaseAfterFailedMark(
            owner,
            publicationStartedAt,
            reservationId,
          );
          throw error;
        }
        if (asset === undefined)
          await this.releaseAfterFailedMark(
            owner,
            publicationStartedAt,
            reservationId,
          );
        if (asset === 'revoked') {
          try {
            await this.storage.deletePublishedObject({
              environment: found.intent.environment,
              publishedKey,
            });
          } catch {
            // The operator's revoke re-run reports the edge still serving.
          }
          throw policy.notFound();
        }
        if (asset === undefined) throw policy.storageUnavailable();
        await this.deleteStaging(found.intent, signal);
        return asset;
      } finally {
        lease?.release();
      }
    }
  }

  private async rejectRefused(
    intent: UploadSessionIntent<C, E>,
    signal: AbortSignal,
    reservationId?: string,
  ): Promise<void> {
    const claimed = await this.repository.claimRefusal?.(intent, reservationId);
    if (claimed === false) return;
    const cleaned = await this.deleteRefused(intent, signal);
    await this.repository.rejectIntent(intent, this.now(), cleaned);
  }

  private async deleteRefused(
    intent: UploadSessionIntent<C, E>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.storage.deleteRefusedObject !== undefined) {
      try {
        return await this.storage.deleteRefusedObject(intent, signal);
      } catch {
        return false;
      }
    }
    try {
      await this.deleteStaging(intent, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteStaging(
    intent: UploadSessionIntent<C, E>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.storage.deleteStagingObject(
        {
          environment: intent.environment,
          stagingKey: intent.stagingKey,
        },
        signal,
      );
    } catch {
      // The sweep retries a failed staging deletion.
    }
  }

  private async releaseAfterFailedMark(
    owner: UploadSessionOwner<E>,
    publicationStartedAt: Date,
    reservationId?: string,
  ): Promise<void> {
    try {
      await this.repository.releasePublication(
        owner,
        publicationStartedAt,
        reservationId,
      );
    } catch {
      // The lease lapses, so the slot frees without an explicit release.
    }
  }
}
