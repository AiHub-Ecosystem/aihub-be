import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '@/modules/secrets/application/runtime-secret-provider.port';
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
  imports: [AuthModule, SecretsModule],
  controllers: [AvatarController],
  providers: [
    {
      provide: AVATAR_DATABASE,
      useFactory: (): AvatarDatabase =>
        createAvatarQueryClient(process.env.DATABASE_URL ?? ''),
    },
    {
      provide: AVATAR_REPOSITORY,
      inject: [AVATAR_DATABASE],
      useFactory: (database: AvatarDatabase): AvatarRepositoryPort =>
        new PostgresAvatarRepository(database),
    },
    {
      provide: AVATAR_STORAGE,
      inject: [RUNTIME_SECRET_PROVIDER],
      useFactory: (secrets: RuntimeSecretProvider): AvatarStoragePort =>
        new S3AvatarStorage(secrets),
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
      ): AvatarUploadService => new AvatarUploadService(avatars, storage),
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
