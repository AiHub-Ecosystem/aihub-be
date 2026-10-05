import { Module } from '@nestjs/common';

import { GatewayModule } from '@/modules/gateway/gateway.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { IdentityModule } from '@/modules/identity/identity.module';
import { MeteringModule } from '@/modules/metering/metering.module';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import { WritingGradingController } from './presentation/writing-grading.controller';

// The grading port (`GradingOrchestratorPort`, token `GRADING_ORCHESTRATOR`)
// used by WritingGradingController is declared and bound by the Gateway
// module, imported above. This module owns no dispatch adapter of its own:
// the per-operation adapters live in `src/downstream/writing/` by source
// boundary (see AGENTS.md, "Source boundaries"), and the dispatch path is
// assembled in `src/modules/gateway/gateway.module.ts`.
@Module({
  imports: [GatewayModule, IdentityModule, IdempotencyModule, MeteringModule],
  controllers: [WritingGradingController],
  providers: [SuccessEnvelopeInterceptor],
})
export class WritingModule {}
