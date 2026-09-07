import { Module } from '@nestjs/common';

import { SuccessEnvelopeInterceptor } from '../../common/http/success-envelope.interceptor';
import { GatewayModule } from '../gateway/gateway.module';
import { DevelopmentOnlyGuard } from './presentation/development-only.guard';
import { WritingQuestionController } from './presentation/writing-question.controller';

@Module({
  imports: [GatewayModule],
  controllers: [WritingQuestionController],
  providers: [DevelopmentOnlyGuard, SuccessEnvelopeInterceptor],
})
export class WritingModule {}
