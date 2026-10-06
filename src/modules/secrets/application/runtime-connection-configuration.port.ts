import type { RuntimeConnectionConfiguration } from '@/config/runtime-configuration';

export const RUNTIME_CONNECTION_CONFIGURATION = Symbol(
  'RUNTIME_CONNECTION_CONFIGURATION',
);

export type RuntimeConnectionConfigurationPort = RuntimeConnectionConfiguration;
