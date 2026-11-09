import type { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import { SuccessEnvelopeInterceptor } from '@/modules/gateway/presentation/success-envelope.interceptor';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
} from '@/modules/gateway/public/graded-pipeline';
import { IdentityModule } from '@/modules/identity/identity.module';
import { MeteringModule } from '@/modules/metering/metering.module';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import { SEAWEEDFS_S3_CLIENT } from '@/modules/secrets/application/seaweedfs-s3-client.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import { SPEAKING_AUDIO_STORAGE } from './application/audio/speaking-audio-storage.port';
import {
  SPEAKING_AUDIO_ASSET_STORAGE,
  SPEAKING_AUDIO_UPLOAD_CLOCK,
  SPEAKING_AUDIO_UPLOAD_REPOSITORY,
  SPEAKING_AUDIO_UPLOAD_SERVICE,
  type SpeakingAudioAssetStoragePort,
  type SpeakingAudioUploadRepositoryPort,
} from './application/audio/speaking-audio-upload.port';
import { SpeakingAudioUploadService } from './application/audio/speaking-audio-upload.service';
import { SpeakingAudioUploadSweep } from './application/audio/speaking-audio-upload.sweep';
import { SPEAKING_AUDIO_URL_REJECTION_RECORDER } from './application/audio/speaking-audio-url-rejection-recorder.port';
import { SPEAKING_MULTIPART_PARSER } from './application/audio/speaking-multipart-parser.port';
import {
  InFlightCeiling,
  SPEAKING_UPLOADS_IN_FLIGHT_MAX,
  SPEAKING_UPLOAD_CEILING,
} from './application/speaking-upload-ceiling';
import {
  SPEAKING_V2_RESULT_OWNERSHIP,
  type SpeakingV2ResultOwnershipPort,
} from './application/speaking-v2-result-ownership.port';
import { SpeakingV2WorkflowEngine } from './application/speaking-v2-workflow-engine';
import { FastifySpeakingMultipartParser } from './infrastructure/fastify-speaking-multipart.parser';
import { PostgresSpeakingAudioUploadRepository } from './infrastructure/postgres-speaking-audio-upload.repository';
import { PostgresSpeakingV2ResultOwnershipRepository } from './infrastructure/postgres-speaking-v2-result-ownership.repository';
import { S3SpeakingAudioAssetStorage } from './infrastructure/s3-speaking-audio-asset.storage';
import { S3SpeakingAudioStorage } from './infrastructure/s3-speaking-audio.storage';
import { recordSpeakingAudioUrlRejection } from './infrastructure/speaking-audio-url-rejection-metric';
import { SpeakingAudioUploadController } from './presentation/speaking-audio-upload.controller';
import { SpeakingGradingController } from './presentation/speaking-grading.controller';
import { SpeakingQuestionsController } from './presentation/speaking-questions.controller';
import { SpeakingV2Controller } from './presentation/speaking-v2.controller';

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
    PersistenceModule,
    SecretsModule,
  ],
  controllers: [
    SpeakingGradingController,
    SpeakingV2Controller,
    SpeakingQuestionsController,
    SpeakingAudioUploadController,
  ],
  providers: [
    {
      provide: SPEAKING_V2_RESULT_OWNERSHIP,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): SpeakingV2ResultOwnershipPort =>
        new PostgresSpeakingV2ResultOwnershipRepository(runtime.prisma),
    },
    {
      provide: SpeakingV2WorkflowEngine,
      inject: [
        GRADED_PIPELINE_ENGINE,
        SPEAKING_UPLOAD_CEILING,
        SPEAKING_V2_RESULT_OWNERSHIP,
      ],
      useFactory: (
        gradedPipeline: GradedPipelineEnginePort,
        uploadCeiling: InFlightCeiling,
        resultOwnership: SpeakingV2ResultOwnershipPort,
      ): SpeakingV2WorkflowEngine =>
        new SpeakingV2WorkflowEngine(
          gradedPipeline,
          uploadCeiling,
          resultOwnership,
        ),
    },
    {
      provide: SPEAKING_AUDIO_UPLOAD_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): SpeakingAudioUploadRepositoryPort =>
        new PostgresSpeakingAudioUploadRepository(runtime.prisma),
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
    {
      provide: SPEAKING_AUDIO_URL_REJECTION_RECORDER,
      useValue: { record: recordSpeakingAudioUrlRejection },
    },
    {
      provide: SPEAKING_UPLOAD_CEILING,
      useValue: new InFlightCeiling(SPEAKING_UPLOADS_IN_FLIGHT_MAX),
    },
  ],
  exports: [SpeakingAudioUploadSweep],
})
export class SpeakingModule {}
