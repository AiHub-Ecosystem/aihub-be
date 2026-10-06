import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { appConfig } from './runtime-configuration';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      skipProcessEnv: true,
      load: [appConfig],
    }),
  ],
  exports: [ConfigModule],
})
export class RuntimeConfigurationModule {}
