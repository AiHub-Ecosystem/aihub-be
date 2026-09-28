import { Module } from '@nestjs/common';

import { GatewayModule } from '../gateway/gateway.module';
import { IdentityModule } from '../identity/identity.module';
import { MeteringModule } from '../metering/metering.module';
import { SuccessEnvelopeInterceptor } from '../metering/presentation/success-envelope.interceptor';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '../secrets/application/runtime-secret-provider.port';
import { SecretsModule } from '../secrets/secrets.module';
import { SPEAKING_AUDIO_STORAGE } from './application/speaking-audio-storage.port';
import { SPEAKING_MULTIPART_PARSER } from './application/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from './infrastructure/fastify-speaking-multipart.parser';
import { S3SpeakingAudioStorage } from './infrastructure/s3-speaking-audio.storage';
import { SpeakingGradingController } from './presentation/speaking-grading.controller';
import { SpeakingQuestionsController } from './presentation/speaking-questions.controller';

@Module({
  imports: [GatewayModule, IdentityModule, MeteringModule, SecretsModule],
  controllers: [SpeakingGradingController, SpeakingQuestionsController],
  providers: [
    SuccessEnvelopeInterceptor,
    {
      provide: SPEAKING_AUDIO_STORAGE,
      useFactory: (
        secretProvider: RuntimeSecretProvider,
      ): S3SpeakingAudioStorage => new S3SpeakingAudioStorage(secretProvider),
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    {
      provide: SPEAKING_MULTIPART_PARSER,
      useClass: FastifySpeakingMultipartParser,
    },
  ],
})
export class SpeakingModule {}
