import type { S3Client } from '@aws-sdk/client-s3';

import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import type { AvatarRepositoryPort } from './application/avatar-repository.port';
import type { AvatarStoragePort } from './application/avatar-storage.port';
import { PostgresAvatarRepository } from './infrastructure/postgres-avatar.repository';
import {
  type AvatarStorageOptions,
  S3AvatarStorage,
} from './infrastructure/s3-avatar.storage';

/** Binds Avatar persistence for Operator commands. */
export function createOperatorAvatarRepository(
  prisma: PrismaClientHolder['prisma'],
): AvatarRepositoryPort {
  return new PostgresAvatarRepository(prisma);
}

/** Builds the Avatar storage an Operator sweep uses on the shared S3 client. */
export function createOperatorAvatarStorage(
  client: S3Client | undefined,
  options: AvatarStorageOptions,
): AvatarStoragePort & { close(): Promise<void> } {
  return new S3AvatarStorage(client, options);
}
