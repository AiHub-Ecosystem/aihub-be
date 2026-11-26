import type { RequestContext } from '@/common/request-context/request-context';
import { UploadSessionVerificationRefusal } from '@/modules/uploads/application/upload-session.errors';
import type { UploadSessionPolicy } from '@/modules/uploads/application/upload-session.policy';
import type {
  UploadSessionGrant,
  UploadSessionRepositoryPort,
  UploadSessionServicePort,
  UploadSessionStoragePort,
} from '@/modules/uploads/application/upload-session.port';
import type {
  PublishedUploadSession,
  UploadSessionIntent,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

const completionTailsByAsset = new Map<string, Promise<void>>();

function serializeCompletion<T>(
  assetId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = completionTailsByAsset.get(assetId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  completionTailsByAsset.set(assetId, tail);
  void tail.then(() => {
    if (completionTailsByAsset.get(assetId) === tail) {
      completionTailsByAsset.delete(assetId);
    }
    return undefined;
  });
  return result;
}

export class UploadSessionService implements UploadSessionServicePort {
  constructor(
    private readonly repository: UploadSessionRepositoryPort,
    private readonly storage: UploadSessionStoragePort,
    private readonly policy: UploadSessionPolicy,
    private readonly newAssetId: (createdAt: Date) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<UploadSessionGrant> {
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
    const intent: UploadSessionIntent = {
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
  }): Promise<UploadSessionGrant> {
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
  }): Promise<PublishedUploadSession> {
    const { policy } = this;
    if (!policy.isAssetId(input.assetId)) throw policy.invalidRequest();
    const owner = policy.owner(input.context, input.assetId);
    const signal =
      policy.completionSignal?.(input.context.signal) ?? input.context.signal;
    return serializeCompletion(owner.assetId, async () => {
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

      const imageUrl = this.storage.publicUrl({
        environment: found.intent.environment,
        publishedKey: found.intent.publishedKey,
      });

      const lease = policy.reserveVerification();
      try {
        const stored = await this.storage.inspectObject(
          {
            environment: found.intent.environment,
            stagingKey: found.intent.stagingKey,
            byteSize: found.intent.byteSize,
          },
          signal,
        );
        if (stored === undefined) throw policy.notFound();
        const refusal = this.invalidStoredObject(stored, found.intent);
        const verification =
          refusal === undefined
            ? await policy.verify({
                contentType: found.intent.contentType,
                bytes: stored.bytes,
                signal,
                lease,
              })
            : undefined;
        const bytes =
          verification?.kind === 'sanitized' ? verification.bytes : undefined;
        if (refusal !== undefined || bytes === undefined) {
          const cleaned = await this.deleteRefused(found.intent, signal);
          await this.repository.rejectIntent(owner, this.now(), cleaned);
          throw (
            refusal ??
            (verification?.kind === 'too_large'
              ? policy.payloadTooLarge()
              : policy.invalidRequest())
          );
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
        if (reservation === 'in_progress')
          throw policy.storageUnavailable(
            'Upload publication is already in progress',
          );
        if (reservation !== 'started') throw policy.notFound();

        try {
          await this.storage.publishObject(
            {
              environment: found.intent.environment,
              stagingKey: found.intent.stagingKey,
              publishedKey: found.intent.publishedKey,
              contentType: found.intent.contentType,
              bytes,
              byteSize: found.intent.byteSize,
            },
            signal,
          );
        } catch (error) {
          await this.repository.releasePublication(owner, publicationStartedAt);
          if (error instanceof UploadSessionVerificationRefusal) {
            const cleaned = await this.deleteRefused(found.intent, signal);
            await this.repository.rejectIntent(owner, this.now(), cleaned);
            throw error.refusal;
          }
          throw error;
        }

        let asset: PublishedUploadSession | 'revoked' | undefined;
        try {
          asset = await this.repository.markPublished({
            owner,
            now: this.now(),
            publicationStartedAt,
            imageUrl,
          });
        } catch (error) {
          await this.releaseAfterFailedMark(owner, publicationStartedAt);
          throw error;
        }
        if (asset === undefined)
          await this.releaseAfterFailedMark(owner, publicationStartedAt);
        if (asset === 'revoked') {
          try {
            await this.storage.deletePublishedObject({
              environment: found.intent.environment,
              publishedKey: found.intent.publishedKey,
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
        lease.release();
      }
    });
  }

  private invalidStoredObject(
    stored: {
      readonly contentType: string | undefined;
      readonly byteSize: number | undefined;
      readonly bytes: Uint8Array;
    },
    intent: UploadSessionIntent,
  ): ReturnType<UploadSessionPolicy['invalidRequest']> | undefined {
    if (this.policy.invalidStoredObject !== undefined) {
      return this.policy.invalidStoredObject(stored, intent);
    }
    if (
      stored.byteSize !== undefined &&
      stored.byteSize > this.policy.maxBytes
    ) {
      return this.policy.payloadTooLarge();
    }
    if (
      stored.byteSize !== intent.byteSize ||
      stored.contentType !== intent.contentType ||
      stored.bytes.byteLength !== stored.byteSize
    ) {
      return this.policy.invalidRequest();
    }
    return undefined;
  }

  private async deleteRefused(
    intent: UploadSessionIntent,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.policy.deleteOnRefusal !== undefined) {
      try {
        return await this.policy.deleteOnRefusal(intent, signal);
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
    intent: UploadSessionIntent,
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
    owner: UploadSessionOwner,
    publicationStartedAt: Date,
  ): Promise<void> {
    try {
      await this.repository.releasePublication(owner, publicationStartedAt);
    } catch {
      // The lease lapses, so the slot frees without an explicit release.
    }
  }
}
