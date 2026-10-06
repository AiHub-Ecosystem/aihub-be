import type { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { AuthModule } from '@/modules/auth/auth.module';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SEAWEEDFS_S3_CLIENT } from '@/modules/secrets/application/seaweedfs-s3-client.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import { AvatarOrphanSweep } from './application/avatar-orphan-sweep';
import {
  AVATAR_REPOSITORY,
  type AvatarRepositoryPort,
} from './application/avatar-repository.port';
import {
  AVATAR_STORAGE,
  type AvatarStoragePort,
} from './application/avatar-storage.port';
import { AvatarUploadService } from './application/avatar-upload.service';
import {
  type AvatarQueryClient,
  PostgresAvatarRepository,
  createAvatarQueryClient,
} from './infrastructure/postgres-avatar.repository';
import { S3AvatarStorage } from './infrastructure/s3-avatar.storage';
import { AvatarController } from './presentation/avatar.controller';

const AVATAR_DATABASE = Symbol('AVATAR_DATABASE');

type AvatarDatabase = AvatarQueryClient & { close(): Promise<void> };

@Module({
  imports: [RuntimeConfigurationModule, AuthModule, SecretsModule],
  controllers: [AvatarController],
  providers: [
    {
      provide: AVATAR_DATABASE,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): AvatarDatabase =>
        createAvatarQueryClient(configuration.databaseUrl ?? ''),
    },
    {
      provide: AVATAR_REPOSITORY,
      inject: [AVATAR_DATABASE],
      useFactory: (database: AvatarDatabase): AvatarRepositoryPort =>
        new PostgresAvatarRepository(database),
    },
    {
      provide: AVATAR_STORAGE,
      inject: [SEAWEEDFS_S3_CLIENT, appConfig.KEY],
      useFactory: (
        client: S3Client | undefined,
        configuration: ConfigType<typeof appConfig>,
      ): AvatarStoragePort =>
        new S3AvatarStorage(client, {
          bucket: configuration.SEAWEEDFS_USER_ASSET_BUCKET,
        }),
    },
    // Published for the operator sweep (`avatar:sweep`), which builds its own
    // instance from CLI-constructed adapters rather than booting Nest.
    {
      provide: AvatarOrphanSweep,
      inject: [AVATAR_REPOSITORY, AVATAR_STORAGE],
      useFactory: (
        avatars: AvatarRepositoryPort,
        storage: AvatarStoragePort,
      ): AvatarOrphanSweep => new AvatarOrphanSweep(avatars, storage),
    },
    {
      provide: AvatarUploadService,
      inject: [AVATAR_REPOSITORY, AVATAR_STORAGE],
      useFactory: (
        avatars: AvatarRepositoryPort,
        storage: AvatarStoragePort,
      ): AvatarUploadService =>
        new AvatarUploadService(avatars, storage, prefixedIdGenerator('ava_')),
    },
  ],
  exports: [AvatarOrphanSweep],
})
export class AvatarModule implements OnModuleDestroy {
  constructor(
    @Inject(AVATAR_DATABASE) private readonly database: AvatarDatabase,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.database.close();
  }
}
