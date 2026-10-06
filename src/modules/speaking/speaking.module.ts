import type { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import { IdentityModule } from '@/modules/identity/identity.module';
import { MeteringModule } from '@/modules/metering/metering.module';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SEAWEEDFS_S3_CLIENT } from '@/modules/secrets/application/seaweedfs-s3-client.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import { SPEAKING_AUDIO_STORAGE } from './application/speaking-audio-storage.port';
import {
  SPEAKING_AUDIO_ASSET_STORAGE,
  SPEAKING_AUDIO_UPLOAD_CLOCK,
  SPEAKING_AUDIO_UPLOAD_REPOSITORY,
  SPEAKING_AUDIO_UPLOAD_SERVICE,
  type SpeakingAudioAssetStoragePort,
  type SpeakingAudioUploadRepositoryPort,
} from './application/speaking-audio-upload.port';
import { SpeakingAudioUploadService } from './application/speaking-audio-upload.service';
import { SpeakingAudioUploadSweep } from './application/speaking-audio-upload.sweep';
import { SPEAKING_MULTIPART_PARSER } from './application/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from './infrastructure/fastify-speaking-multipart.parser';
import {
  PostgresSpeakingAudioUploadRepository,
  type SpeakingAudioQueryClient,
  createSpeakingAudioQueryClient,
} from './infrastructure/postgres-speaking-audio-upload.repository';
import { S3SpeakingAudioAssetStorage } from './infrastructure/s3-speaking-audio-asset.storage';
import { S3SpeakingAudioStorage } from './infrastructure/s3-speaking-audio.storage';
import { SpeakingAudioUploadController } from './presentation/speaking-audio-upload.controller';
import { SpeakingGradingController } from './presentation/speaking-grading.controller';
import { SpeakingQuestionsController } from './presentation/speaking-questions.controller';

const SPEAKING_AUDIO_DATABASE = Symbol('SPEAKING_AUDIO_DATABASE');

type SpeakingAudioDatabase = SpeakingAudioQueryClient;

// Grading for Speaking goes through the same shared
// `GradingOrchestratorPort`/`GRADING_ORCHESTRATOR` declared and bound by the
// Gateway module. This module's `infrastructure/` layer is only multipart
// parsing and Audio asset storage; no Speaking-local grading adapter exists
// — per-operation adapters live in `src/downstream/speaking/` by source
// boundary (AGENTS.md, "Source boundaries").
@Module({
  imports: [
    RuntimeConfigurationModule,
    GatewayModule,
    IdentityModule,
    MeteringModule,
    SecretsModule,
  ],
  controllers: [
    SpeakingGradingController,
    SpeakingQuestionsController,
    SpeakingAudioUploadController,
  ],
  providers: [
    {
      provide: SPEAKING_AUDIO_DATABASE,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): SpeakingAudioDatabase =>
        createSpeakingAudioQueryClient(configuration.databaseUrl ?? ''),
    },
    {
      provide: SPEAKING_AUDIO_UPLOAD_REPOSITORY,
      inject: [SPEAKING_AUDIO_DATABASE],
      useFactory: (
        database: SpeakingAudioDatabase,
      ): SpeakingAudioUploadRepositoryPort =>
        new PostgresSpeakingAudioUploadRepository(database),
    },
    {
      provide: SPEAKING_AUDIO_ASSET_STORAGE,
      inject: [SEAWEEDFS_S3_CLIENT, appConfig.KEY],
      useFactory: (
        client: S3Client | undefined,
        configuration: ConfigType<typeof appConfig>,
      ): SpeakingAudioAssetStoragePort => {
        const bucket = configuration.SEAWEEDFS_AUDIO_ASSET_BUCKET;
        return new S3SpeakingAudioAssetStorage(
          client,
          configuration.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox'
            ? bucket === undefined
              ? {}
              : { sandboxBucket: bucket }
            : bucket === undefined
              ? {}
              : { productionBucket: bucket },
        );
      },
    },
    {
      provide: SPEAKING_AUDIO_UPLOAD_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: SPEAKING_AUDIO_UPLOAD_SERVICE,
      inject: [
        SPEAKING_AUDIO_UPLOAD_REPOSITORY,
        SPEAKING_AUDIO_ASSET_STORAGE,
        SPEAKING_AUDIO_UPLOAD_CLOCK,
      ],
      useFactory: (
        repository: SpeakingAudioUploadRepositoryPort,
        storage: SpeakingAudioAssetStoragePort,
        clock: () => Date,
      ) =>
        new SpeakingAudioUploadService(
          repository,
          storage,
          prefixedIdGenerator('aud_'),
          clock,
        ),
    },
    {
      provide: SpeakingAudioUploadSweep,
      inject: [SPEAKING_AUDIO_UPLOAD_REPOSITORY, SPEAKING_AUDIO_ASSET_STORAGE],
      useFactory: (
        repository: SpeakingAudioUploadRepositoryPort,
        storage: SpeakingAudioAssetStoragePort,
      ) => new SpeakingAudioUploadSweep(repository, storage),
    },
    SuccessEnvelopeInterceptor,
    {
      provide: SPEAKING_AUDIO_STORAGE,
      useFactory: (
        client: S3Client | undefined,
        configuration: ConfigType<typeof appConfig>,
      ): S3SpeakingAudioStorage =>
        new S3SpeakingAudioStorage(client, {
          bucket: configuration.SEAWEEDFS_BUCKET,
        }),
      inject: [SEAWEEDFS_S3_CLIENT, appConfig.KEY],
    },
    {
      provide: SPEAKING_MULTIPART_PARSER,
      useClass: FastifySpeakingMultipartParser,
    },
  ],
  exports: [SpeakingAudioUploadSweep],
})
export class SpeakingModule implements OnModuleDestroy {
  constructor(
    @Inject(SPEAKING_AUDIO_DATABASE)
    private readonly database: SpeakingAudioDatabase,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.database.close();
  }
}
