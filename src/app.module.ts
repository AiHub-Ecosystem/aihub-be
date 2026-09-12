import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { HealthController } from './health/health.controller';
import { GatewayModule } from './modules/gateway/gateway.module';
import { IdentityModule } from './modules/identity/identity.module';
import { SpeakingModule } from './modules/speaking/speaking.module';
import { WritingModule } from './modules/writing/writing.module';
import { OpenApiModule } from './openapi/openapi.module';

@Module({
  controllers: [HealthController],
  imports: [
    IdentityModule,
    GatewayModule,
    WritingModule,
    SpeakingModule,
    OpenApiModule,
  ],
  providers: [
    // Bound through APP_FILTER rather than `useGlobalFilters` in main.ts so the
    // filter is also active in tests built with Nest's testing module.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
