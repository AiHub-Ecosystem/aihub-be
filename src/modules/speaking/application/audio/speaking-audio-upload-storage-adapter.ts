import {
  type SpeakingAudioContentType,
  type SpeakingAudioEnvironment,
  isSpeakingAudioContentType,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  type UploadSessionIntent,
  type UploadSessionStoragePort,
  UploadSessionVerificationRefusal,
} from '@/modules/uploads/public';
import {
  speakingFinalRefusal,
  speakingStagingRefusal,
} from './speaking-audio-upload-session.refusal';
import type { SpeakingAudioAssetStoragePort } from './speaking-audio-upload.port';

type CoreIntent = UploadSessionIntent<
  SpeakingAudioContentType,
  SpeakingAudioEnvironment
>;

/** Storage-specific half of the shared upload-session adapter. */
export class SpeakingAudioCoreStorageAdapter
  implements
    UploadSessionStoragePort<SpeakingAudioContentType, SpeakingAudioEnvironment>
{
  constructor(private readonly storage: SpeakingAudioAssetStoragePort) {}

  async createUploadUrl(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly stagingKey: string;
    readonly contentType: SpeakingAudioContentType;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const signed = await this.storage.createUploadUrl({
      environment: input.environment,
      objectKey: input.stagingKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    return { ...signed, fields: {} };
  }

  async inspectObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
      readonly contentType?: SpeakingAudioContentType;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: SpeakingAudioContentType | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
      }
    | undefined
  > {
    const described = await this.storage.describeObject(
      { environment: input.environment, objectKey: input.stagingKey },
      signal,
    );
    if (described === undefined) return undefined;
    const refusal = speakingStagingRefusal(described, {
      contentType: input.contentType ?? '',
      byteSize: input.byteSize,
    });
    if (refusal !== undefined)
      throw new UploadSessionVerificationRefusal(refusal);
    return {
      contentType: isSpeakingAudioContentType(described.contentType)
        ? described.contentType
        : undefined,
      byteSize: described.byteSize,
      bytes: new Uint8Array(),
    };
  }

  async publishObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: SpeakingAudioContentType;
      readonly bytes: Uint8Array;
      readonly byteSize?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.copyObject(
      {
        environment: input.environment,
        sourceObjectKey: input.stagingKey,
        destinationObjectKey: input.publishedKey,
      },
      signal,
    );
    const final = await this.storage.describeObject(
      { environment: input.environment, objectKey: input.publishedKey },
      signal,
    );
    const refusal = speakingFinalRefusal(
      { contentType: final?.contentType, byteSize: final?.byteSize },
      {
        contentType: input.contentType,
        byteSize: input.byteSize ?? 0,
      },
    );
    if (refusal !== undefined)
      throw new UploadSessionVerificationRefusal(refusal);
  }

  async deleteRefusedObject(
    intent: CoreIntent,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return true;
    try {
      await this.storage.deleteObject(
        { environment: intent.environment, objectKey: intent.publishedKey },
        signal,
      );
      await this.storage.deleteObject(
        { environment: intent.environment, objectKey: intent.stagingKey },
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(): string {
    return '';
  }

  async deleteStagingObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.deleteObject(
      { environment: input.environment, objectKey: input.stagingKey },
      signal,
    );
  }

  async deletePublishedObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly publishedKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.deleteObject(
      { environment: input.environment, objectKey: input.publishedKey },
      signal,
    );
  }

  private deleteObject(
    input: Parameters<SpeakingAudioAssetStoragePort['deleteObject']>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    return signal === undefined
      ? this.storage.deleteObject(input)
      : this.storage.deleteObject(input, signal);
  }
}
