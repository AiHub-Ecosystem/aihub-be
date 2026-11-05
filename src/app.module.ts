import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { RejectUnstorableTextPipe } from './common/http/reject-unstorable-text.pipe';
import { RequestLogContextInterceptor } from './common/observability/request-log-context.interceptor';
import { createNestPinoOptions } from './common/observability/request-logger';
import type { RuntimeConfiguration } from './config/runtime-configuration';
import { RuntimeConfigurationModule } from './config/runtime-configuration.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AvatarModule } from './modules/avatar/avatar.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MeteringModule } from './modules/metering/metering.module';
import { HttpExceptionFilter } from './modules/metering/presentation/http-exception.filter';
import { PersistenceModule } from './modules/persistence/persistence.module';
import { SpeakingModule } from './modules/speaking/speaking.module';
import { WritingModule } from './modules/writing/writing.module';
import { OpenApiModule } from './openapi/openapi.module';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [RuntimeConfigurationModule],
      inject: [ConfigService],
      useFactory: (configuration: ConfigService<RuntimeConfiguration>) =>
        createNestPinoOptions(configuration.get('LOG_LEVEL', { infer: true })),
    }),
    RuntimeConfigurationModule,
    PersistenceModule,
    HealthModule,
    AuthModule,
    AvatarModule,
    IdentityModule,
    GatewayModule,
    WritingModule,
    SpeakingModule,
    MeteringModule,
    OpenApiModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestLogContextInterceptor },
    // Bound through APP_FILTER rather than `useGlobalFilters` in main.ts so the
    // filter is also active in tests built with Nest's testing module.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useClass: RejectUnstorableTextPipe },
  ],
})
export class AppModule {}
