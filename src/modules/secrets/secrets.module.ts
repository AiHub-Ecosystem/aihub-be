import { Module } from '@nestjs/common';

import { RUNTIME_SECRET_PROVIDER } from './application/runtime-secret-provider.port';
import { createRuntimeSecretProviderFromProcessEnvironment } from './infrastructure/configured-runtime-secret.provider';

@Module({
  providers: [
    {
      provide: RUNTIME_SECRET_PROVIDER,
      useFactory: createRuntimeSecretProviderFromProcessEnvironment,
    },
  ],
  exports: [RUNTIME_SECRET_PROVIDER],
})
export class SecretsModule {}
