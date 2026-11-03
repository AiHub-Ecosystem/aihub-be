import { Module } from '@nestjs/common';

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
} from '@/modules/gateway/application/grading-orchestrator.port';
import { IDEMPOTENCY_SERVICE } from '@/modules/idempotency/application/idempotency-service.port';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/metering-finalizer.port';
import { MeteringModule } from '@/modules/metering/metering.module';
import { GradedPipelineEngine } from './application/graded-pipeline-engine';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
} from './application/graded-pipeline.port';
import { GatewayModule } from './gateway.module';

@Module({
  imports: [GatewayModule, IdempotencyModule, MeteringModule],
  providers: [
    {
      provide: GRADED_PIPELINE_ENGINE,
      inject: [
        GRADING_ORCHESTRATOR,
        METERING_FINALIZER,
        GRADED_ADMISSION,
        CONCURRENCY_LIMITER,
        IDEMPOTENCY_SERVICE,
      ],
      useFactory: (
        orchestrator: GradingOrchestratorPort,
        finalizer: MeteringFinalizerPort,
        admission: GradedAdmissionPort,
        concurrencyLimiter: ConcurrencyLimiterPort,
        idempotency: IdempotencyServicePort,
      ): GradedPipelineEnginePort =>
        new GradedPipelineEngine(
          orchestrator,
          finalizer,
          admission,
          concurrencyLimiter,
          idempotency,
        ),
    },
  ],
  exports: [GRADED_PIPELINE_ENGINE],
})
export class GatewayGradedRequestModule {}
