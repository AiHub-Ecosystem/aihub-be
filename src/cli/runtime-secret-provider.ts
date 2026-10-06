import process from 'node:process';

import { createRuntimeSecretProvider } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';

/** CLI composition reads its own environment and does not boot Nest config. */
export function createCliRuntimeSecretProvider() {
  return createRuntimeSecretProvider({
    nodeEnv: process.env.NODE_ENV,
    source: process.env.AIHUB_RUNTIME_SECRET_SOURCE,
    secretsFile: process.env.AIHUB_RUNTIME_SECRETS_FILE,
    values: process.env,
  });
}
