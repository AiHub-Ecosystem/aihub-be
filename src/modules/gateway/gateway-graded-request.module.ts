import { Module } from '@nestjs/common';

import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/metering-finalizer.port';
import { MeteringModule } from '@/modules/metering/metering.module';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
} from './application/grading-orchestrator.port';
import { GatewayModule } from './gateway.module';
import { GradedRequestExecutor } from './presentation/graded-request-executor';
import { GRADED_REQUEST_EXECUTOR } from './public/graded-request-executor';

@Module({
  imports: [GatewayModule, MeteringModule],
  providers: [
    {
      provide: GRADED_REQUEST_EXECUTOR,
      inject: [GRADING_ORCHESTRATOR, METERING_FINALIZER],
      useFactory: (
        orchestrator: GradingOrchestratorPort,
        finalizer: MeteringFinalizerPort,
      ): GradedRequestExecutor =>
        new GradedRequestExecutor(orchestrator, finalizer),
    },
  ],
  exports: [GRADED_REQUEST_EXECUTOR],
})
export class GatewayGradedRequestModule {}
