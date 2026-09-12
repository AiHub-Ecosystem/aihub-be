import { Module } from '@nestjs/common';

import { SuccessEnvelopeInterceptor } from '../../common/http/success-envelope.interceptor';
import { GatewayModule } from '../gateway/gateway.module';
import { IdentityModule } from '../identity/identity.module';
import { SPEAKING_MULTIPART_PARSER } from './application/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from './infrastructure/fastify-speaking-multipart.parser';
import { SpeakingGradingController } from './presentation/speaking-grading.controller';

@Module({
  imports: [GatewayModule, IdentityModule],
  controllers: [SpeakingGradingController],
  providers: [
    SuccessEnvelopeInterceptor,
    {
      provide: SPEAKING_MULTIPART_PARSER,
      useClass: FastifySpeakingMultipartParser,
    },
  ],
})
export class SpeakingModule {}
