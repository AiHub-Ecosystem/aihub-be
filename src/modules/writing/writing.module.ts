import type { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { GatewayGradedRequestModule } from '@/modules/gateway/gateway-graded-request.module';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { IdentityModule } from '@/modules/identity/identity.module';
import { MeteringModule } from '@/modules/metering/metering.module';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import { SEAWEEDFS_S3_CLIENT } from '@/modules/secrets/application/seaweedfs-s3-client.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import {
  WRITING_CHART_UPLOAD_CLOCK,
  WRITING_CHART_UPLOAD_REPOSITORY,
  WRITING_CHART_UPLOAD_SERVICE,
  WRITING_CHART_UPLOAD_STORAGE,
  type WritingChartUploadRepositoryPort,
  type WritingChartUploadStoragePort,
} from './application/writing-chart-upload.port';
import { WritingChartUploadService } from './application/writing-chart-upload.service';
import { WritingChartUploadSweep } from './application/writing-chart-upload.sweep';
import { PostgresWritingChartUploadRepository } from './infrastructure/postgres-writing-chart-upload.repository';
import { S3WritingChartUploadStorage } from './infrastructure/s3-writing-chart-upload.storage';
import { WritingChartUploadController } from './presentation/writing-chart-upload.controller';
import { WritingGradingController } from './presentation/writing-grading.controller';

@Module({
  imports: [
    RuntimeConfigurationModule,
    GatewayGradedRequestModule,
    GatewayModule,
    IdentityModule,
    IdempotencyModule,
    MeteringModule,
    PersistenceModule,
    SecretsModule,
  ],
  controllers: [WritingGradingController, WritingChartUploadController],
  providers: [
    SuccessEnvelopeInterceptor,
    {
      provide: WRITING_CHART_UPLOAD_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): WritingChartUploadRepositoryPort =>
        new PostgresWritingChartUploadRepository(runtime.prisma),
    },
    {
      provide: WRITING_CHART_UPLOAD_STORAGE,
      inject: [SEAWEEDFS_S3_CLIENT, appConfig.KEY],
      useFactory: (
        client: S3Client | undefined,
        configuration: ConfigType<typeof appConfig>,
      ): WritingChartUploadStoragePort =>
        new S3WritingChartUploadStorage(client, {
          environment:
            configuration.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox'
              ? 'sandbox'
              : 'production',
          ...(configuration.SEAWEEDFS_CHART_STAGING_BUCKET === undefined
            ? {}
            : { stagingBucket: configuration.SEAWEEDFS_CHART_STAGING_BUCKET }),
          ...(configuration.SEAWEEDFS_CHART_PUBLIC_BUCKET === undefined
            ? {}
            : { publicBucket: configuration.SEAWEEDFS_CHART_PUBLIC_BUCKET }),
          ...(configuration.AIHUB_CHART_PUBLIC_BASE_URL === undefined
            ? {}
            : { publicBaseUrl: configuration.AIHUB_CHART_PUBLIC_BASE_URL }),
        }),
    },
    {
      provide: WRITING_CHART_UPLOAD_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: WRITING_CHART_UPLOAD_SERVICE,
      inject: [
        WRITING_CHART_UPLOAD_REPOSITORY,
        WRITING_CHART_UPLOAD_STORAGE,
        WRITING_CHART_UPLOAD_CLOCK,
      ],
      useFactory: (
        repository: WritingChartUploadRepositoryPort,
        storage: WritingChartUploadStoragePort,
        clock: () => Date,
      ) =>
        new WritingChartUploadService(
          repository,
          storage,
          prefixedIdGenerator('chart_'),
          clock,
        ),
    },
    {
      provide: WritingChartUploadSweep,
      inject: [WRITING_CHART_UPLOAD_REPOSITORY, WRITING_CHART_UPLOAD_STORAGE],
      useFactory: (
        repository: WritingChartUploadRepositoryPort,
        storage: WritingChartUploadStoragePort,
      ) => new WritingChartUploadSweep(repository, storage),
    },
  ],
  exports: [WritingChartUploadSweep],
})
export class WritingModule {}
