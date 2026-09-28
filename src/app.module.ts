import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { HealthController } from './health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MeteringModule } from './modules/metering/metering.module';
import { HttpExceptionFilter } from './modules/metering/presentation/http-exception.filter';
import { SpeakingModule } from './modules/speaking/speaking.module';
import { WritingModule } from './modules/writing/writing.module';
import { OpenApiModule } from './openapi/openapi.module';

@Module({
  controllers: [HealthController],
  imports: [
    AuthModule,
    IdentityModule,
    GatewayModule,
    WritingModule,
    SpeakingModule,
    MeteringModule,
    OpenApiModule,
  ],
  providers: [
    // Bound through APP_FILTER rather than `useGlobalFilters` in main.ts so the
    // filter is also active in tests built with Nest's testing module.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
