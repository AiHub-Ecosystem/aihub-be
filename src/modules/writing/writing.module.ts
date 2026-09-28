import { Module } from '@nestjs/common';

import { GatewayModule } from '../gateway/gateway.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { IdentityModule } from '../identity/identity.module';
import { MeteringModule } from '../metering/metering.module';
import { SuccessEnvelopeInterceptor } from '../metering/presentation/success-envelope.interceptor';
import { WritingGradingController } from './presentation/writing-grading.controller';

@Module({
  imports: [GatewayModule, IdentityModule, IdempotencyModule, MeteringModule],
  controllers: [WritingGradingController],
  providers: [SuccessEnvelopeInterceptor],
})
export class WritingModule {}
