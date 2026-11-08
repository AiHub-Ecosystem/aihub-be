import type { S3Client } from '@aws-sdk/client-s3';
import { Module, type Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { internalError } from '@/common/errors/app-error';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { GatewayGradedRequestModule } from '@/modules/gateway/gateway-graded-request.module';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
} from '@/modules/gateway/public/graded-pipeline';
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
import { SPEAKING_AUDIO_URL_REJECTION_RECORDER } from './application/speaking-audio-url-rejection-recorder.port';
import { SPEAKING_MULTIPART_PARSER } from './application/speaking-multipart-parser.port';
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
import { SpeakingGradingJobsController } from './presentation/speaking-grading-jobs.controller';
import { SpeakingGradingController } from './presentation/speaking-grading.controller';
import { SpeakingQuestionsController } from './presentation/speaking-questions.controller';
import { SpeakingV2Controller } from './presentation/speaking-v2.controller';

import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from '@/modules/gateway/application/concurrency-limiter.port';
import {
  GRADED_ADMISSION,
  type GradedAdmissionPort,
} from '@/modules/gateway/application/graded-admission.port';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
} from '@/modules/gateway/application/graded-request/grading-orchestrator.port';
import {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxDispatchBudgetPort,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';

import { GetSpeakingGradingJob } from './application/grading-jobs/get-speaking-grading-job';
import { ProcessSpeakingGradingJob } from './application/grading-jobs/process-speaking-grading-job';
import {
  SPEAKING_GRADING_JOB_QUEUE,
  SPEAKING_GRADING_JOB_REPOSITORY,
  type SpeakingGradingJobQueuePort,
  type SpeakingGradingJobRepositoryPort,
} from './application/grading-jobs/speaking-grading-job.port';
import { SpeakingGradingJobSweep } from './application/grading-jobs/speaking-grading-job.sweep';
import { SubmitSpeakingGradingJob } from './application/grading-jobs/submit-speaking-grading-job';
import { BullmqSpeakingGradingJobConsumer } from './infrastructure/grading-jobs/bullmq-speaking-grading-job.consumer';
import { BullmqSpeakingGradingJobQueue } from './infrastructure/grading-jobs/bullmq-speaking-grading-job.queue';
import { PostgresSpeakingGradingJobRepository } from './infrastructure/grading-jobs/postgres-speaking-grading-job.repository';
import { SpeakingGradingJobSweepScheduler } from './infrastructure/grading-jobs/speaking-grading-job-sweep-scheduler';

/**
 * Jobs a worker grades at once in this process, per Environment queue. The
 * Organization's Concurrency permit still bounds each Organization.
 * ponytail: fixed per process; make it configuration when worker load is measured.
 */
const SPEAKING_GRADING_JOB_CONCURRENCY = 4;

/** Without Redis the queue refuses; submit still answers 202 and the sweep re-enqueues later. */
const UNAVAILABLE_QUEUE: SpeakingGradingJobQueuePort = {
  enqueue: () =>
    Promise.reject(internalError('Speaking grading job queue is unavailable')),
};

/** Background work (worker and sweep) runs only outside tests and with Redis configured. */
function backgroundEnabled(
  configuration: ConfigType<typeof appConfig>,
  connections: RuntimeConnectionConfigurationPort,
): string | undefined {
  const url = connections.redisUrl?.trim();
  return configuration.NODE_ENV !== 'test' && url !== undefined && url !== ''
    ? url
    : undefined;
}

/** Providers for the async Speaking grading job (ADR-0159). */
const SPEAKING_GRADING_JOB_PROVIDERS: Provider[] = [
  {
    provide: SPEAKING_GRADING_JOB_REPOSITORY,
    inject: [RUNTIME_PRISMA_CLIENT],
    useFactory: (
      runtime: PrismaClientHolder,
    ): SpeakingGradingJobRepositoryPort =>
      new PostgresSpeakingGradingJobRepository(runtime.prisma),
  },
  {
    provide: SPEAKING_GRADING_JOB_QUEUE,
    inject: [RUNTIME_CONNECTION_CONFIGURATION],
    useFactory: (
      connections: RuntimeConnectionConfigurationPort,
    ): SpeakingGradingJobQueuePort => {
      const url = connections.redisUrl?.trim();
      return url === undefined || url === ''
        ? UNAVAILABLE_QUEUE
        : new BullmqSpeakingGradingJobQueue(url);
    },
  },
  {
    provide: SubmitSpeakingGradingJob,
    inject: [
      SPEAKING_GRADING_JOB_REPOSITORY,
      SPEAKING_GRADING_JOB_QUEUE,
      SPEAKING_AUDIO_UPLOAD_REPOSITORY,
      GRADED_ADMISSION,
      SANDBOX_DISPATCH_BUDGET,
      IDEMPOTENCY_SERVICE,
    ],
    useFactory: (
      repository: SpeakingGradingJobRepositoryPort,
      queue: SpeakingGradingJobQueuePort,
      audio: SpeakingAudioUploadRepositoryPort,
      admission: GradedAdmissionPort,
      sandboxBudget: SandboxDispatchBudgetPort,
      idempotency: IdempotencyServicePort,
    ) =>
      new SubmitSpeakingGradingJob(
        repository,
        queue,
        audio,
        admission,
        sandboxBudget,
        idempotency,
      ),
  },
  {
    provide: GetSpeakingGradingJob,
    inject: [SPEAKING_GRADING_JOB_REPOSITORY],
    useFactory: (repository: SpeakingGradingJobRepositoryPort) =>
      new GetSpeakingGradingJob(repository),
  },
  {
    provide: ProcessSpeakingGradingJob,
    inject: [
      SPEAKING_GRADING_JOB_REPOSITORY,
      SPEAKING_GRADING_JOB_QUEUE,
      SPEAKING_AUDIO_UPLOAD_REPOSITORY,
      SPEAKING_AUDIO_ASSET_STORAGE,
      CONCURRENCY_LIMITER,
      GRADING_ORCHESTRATOR,
      SPEAKING_V2_RESULT_OWNERSHIP,
      METERING_FINALIZER,
      SANDBOX_DISPATCH_BUDGET,
    ],
    useFactory: (
      repository: SpeakingGradingJobRepositoryPort,
      queue: SpeakingGradingJobQueuePort,
      audioRepository: SpeakingAudioUploadRepositoryPort,
      audioStorage: SpeakingAudioAssetStoragePort,
      concurrencyLimiter: ConcurrencyLimiterPort,
      orchestrator: GradingOrchestratorPort,
      resultOwnership: SpeakingV2ResultOwnershipPort,
      finalizer: MeteringFinalizerPort,
      sandboxBudget: SandboxDispatchBudgetPort,
    ) =>
      new ProcessSpeakingGradingJob({
        repository,
        queue,
        audioRepository,
        audioStorage,
        concurrencyLimiter,
        orchestrator,
        resultOwnership,
        finalizer,
        sandboxBudget,
      }),
  },
  {
    provide: SpeakingGradingJobSweep,
    inject: [
      SPEAKING_GRADING_JOB_REPOSITORY,
      SPEAKING_GRADING_JOB_QUEUE,
      SANDBOX_DISPATCH_BUDGET,
    ],
    useFactory: (
      repository: SpeakingGradingJobRepositoryPort,
      queue: SpeakingGradingJobQueuePort,
      sandboxBudget: SandboxDispatchBudgetPort,
    ) => new SpeakingGradingJobSweep(repository, queue, sandboxBudget),
  },
  {
    provide: SpeakingGradingJobSweepScheduler,
    inject: [
      SpeakingGradingJobSweep,
      appConfig.KEY,
      RUNTIME_CONNECTION_CONFIGURATION,
    ],
    useFactory: (
      sweep: SpeakingGradingJobSweep,
      configuration: ConfigType<typeof appConfig>,
      connections: RuntimeConnectionConfigurationPort,
    ): SpeakingGradingJobSweepScheduler | object =>
      backgroundEnabled(configuration, connections) === undefined
        ? {}
        : new SpeakingGradingJobSweepScheduler(sweep),
  },
  {
    provide: BullmqSpeakingGradingJobConsumer,
    inject: [
      ProcessSpeakingGradingJob,
      appConfig.KEY,
      RUNTIME_CONNECTION_CONFIGURATION,
    ],
    useFactory: (
      processor: ProcessSpeakingGradingJob,
      configuration: ConfigType<typeof appConfig>,
      connections: RuntimeConnectionConfigurationPort,
    ): BullmqSpeakingGradingJobConsumer | object => {
      const url = backgroundEnabled(configuration, connections);
      return url === undefined
        ? {}
        : new BullmqSpeakingGradingJobConsumer(
            url,
            (input) => processor.execute(input),
            { concurrency: SPEAKING_GRADING_JOB_CONCURRENCY },
          );
    },
  },
];

// Grading for Speaking goes through the same shared
// `GradingOrchestratorPort`/`GRADING_ORCHESTRATOR` declared and bound by the
// Gateway module. This module's `infrastructure/` layer is only multipart
// parsing and Audio asset storage; no Speaking-local grading adapter exists
// — per-operation adapters live in `src/downstream/speaking/` by source
// boundary (AGENTS.md, "Source boundaries").
@Module({
  imports: [
    RuntimeConfigurationModule,
    GatewayGradedRequestModule,
    GatewayModule,
    IdempotencyModule,
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
    SpeakingGradingJobsController,
  ],
  providers: [
    ...SPEAKING_GRADING_JOB_PROVIDERS,
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
