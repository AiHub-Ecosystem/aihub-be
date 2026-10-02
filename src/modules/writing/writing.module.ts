import { Module } from '@nestjs/common';

import { GatewayModule } from '@/modules/gateway/gateway.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { IdentityModule } from '@/modules/identity/identity.module';
import { MeteringModule } from '@/modules/metering/metering.module';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import { WritingGradingController } from './presentation/writing-grading.controller';

@Module({
  imports: [GatewayModule, IdentityModule, IdempotencyModule, MeteringModule],
  controllers: [WritingGradingController],
  providers: [SuccessEnvelopeInterceptor],
})
export class WritingModule {}
