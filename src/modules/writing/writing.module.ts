import { Module } from '@nestjs/common';

import { SuccessEnvelopeInterceptor } from '../../common/http/success-envelope.interceptor';
import { GatewayModule } from '../gateway/gateway.module';
import { IdentityModule } from '../identity/identity.module';
import { WritingGradingController } from './presentation/writing-grading.controller';
import { WritingQuestionController } from './presentation/writing-question.controller';
import { WritingTask2QuestionController } from './presentation/writing-task2-question.controller';

@Module({
  imports: [GatewayModule, IdentityModule],
  controllers: [
    WritingQuestionController,
    WritingTask2QuestionController,
    WritingGradingController,
  ],
  providers: [SuccessEnvelopeInterceptor],
})
export class WritingModule {}
