import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { GatewayModule } from './modules/gateway/gateway.module';
import { IdentityModule } from './modules/identity/identity.module';
import { WritingModule } from './modules/writing/writing.module';

@Module({
  controllers: [HealthController],
  imports: [IdentityModule, GatewayModule, WritingModule],
})
export class AppModule {}
