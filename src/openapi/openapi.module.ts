import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { OpenApiController } from './openapi.controller';

@Module({
  imports: [AuthModule],
  controllers: [OpenApiController],
})
export class OpenApiModule {}
