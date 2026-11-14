import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { FETCH_LEGACY_CONTENT_PORT } from './application/legacy-content.port';
import { HttpLegacyContentClient } from './infrastructure/http-legacy-content.client';
import { ContentProxyController } from './presentation/content-proxy.controller';

@Module({
  imports: [RuntimeConfigurationModule],
  controllers: [ContentProxyController],
  providers: [
    {
      provide: FETCH_LEGACY_CONTENT_PORT,
      inject: [appConfig.KEY],
      useFactory: (
        configuration: ConfigType<typeof appConfig>,
      ): HttpLegacyContentClient =>
        new HttpLegacyContentClient(configuration.AIHUB_LEGACY_BACKEND_URL),
    },
  ],
})
export class ContentProxyModule {}
