import { Module } from '@nestjs/common';

import { SuccessEnvelopeInterceptor } from '../../common/http/success-envelope.interceptor';
import { GatewayModule } from '../gateway/gateway.module';
import { IdentityModule } from '../identity/identity.module';
import { RateLimitGuard } from './presentation/rate-limit.guard';
import { WritingQuestionController } from './presentation/writing-question.controller';

@Module({
  imports: [GatewayModule, IdentityModule],
  controllers: [WritingQuestionController],
  providers: [RateLimitGuard, SuccessEnvelopeInterceptor],
})
export class WritingModule {}
