import type { S3Client } from '@aws-sdk/client-s3';

import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './application/audio/speaking-audio-upload.port';
import { PostgresSpeakingAudioUploadRepository } from './infrastructure/postgres-speaking-audio-upload.repository';
import {
  S3SpeakingAudioAssetStorage,
  type SpeakingAudioAssetStorageOptions,
} from './infrastructure/s3-speaking-audio-asset.storage';

/** Binds Speaking audio persistence for Operator commands. */
export function createOperatorSpeakingAudioUploadRepository(
  prisma: PrismaClientHolder['prisma'],
): SpeakingAudioUploadRepositoryPort {
  return new PostgresSpeakingAudioUploadRepository(prisma);
}

/** Builds the Speaking audio storage an Operator sweep uses on the shared S3 client. */
export function createOperatorSpeakingAudioAssetStorage(
  client: S3Client | undefined,
  options: SpeakingAudioAssetStorageOptions,
): SpeakingAudioAssetStoragePort & { close(): Promise<void> } {
  return new S3SpeakingAudioAssetStorage(client, options);
}
