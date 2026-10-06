import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import {
  appConfig,
  getRuntimeConnectionConfiguration,
  getRuntimeSecretEnvironment,
} from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { RUNTIME_CONNECTION_CONFIGURATION } from './application/runtime-connection-configuration.port';
import { RUNTIME_SECRET_PROVIDER } from './application/runtime-secret-provider.port';
import { SEAWEEDFS_S3_CLIENT } from './application/seaweedfs-s3-client.port';
import { createRuntimeSecretProvider } from './infrastructure/configured-runtime-secret.provider';
import { createSeaweedFsS3Client } from './infrastructure/seaweedfs-s3-client.factory';

@Module({
  imports: [RuntimeConfigurationModule],
  providers: [
    {
      provide: RUNTIME_SECRET_PROVIDER,
      inject: [appConfig.KEY],
      useFactory: (configuration: ConfigType<typeof appConfig>) =>
        createRuntimeSecretProvider({
          nodeEnv: configuration.NODE_ENV,
          source: configuration.AIHUB_RUNTIME_SECRET_SOURCE,
          secretsFile: configuration.AIHUB_RUNTIME_SECRETS_FILE,
          values: getRuntimeSecretEnvironment(),
        }),
    },
    {
      provide: RUNTIME_CONNECTION_CONFIGURATION,
      useFactory: getRuntimeConnectionConfiguration,
    },
    {
      provide: SEAWEEDFS_S3_CLIENT,
      inject: [RUNTIME_SECRET_PROVIDER, appConfig.KEY],
      useFactory: (
        secrets: ReturnType<typeof createRuntimeSecretProvider>,
        configuration: ConfigType<typeof appConfig>,
      ) =>
        createSeaweedFsS3Client({
          endpoint: configuration.SEAWEEDFS_ENDPOINT_URL,
          region: configuration.SEAWEEDFS_REGION,
          credentials: secrets.getSnapshot().seaweedfs,
        }),
    },
  ],
  exports: [
    RUNTIME_SECRET_PROVIDER,
    RUNTIME_CONNECTION_CONFIGURATION,
    SEAWEEDFS_S3_CLIENT,
  ],
})
export class SecretsModule {}
