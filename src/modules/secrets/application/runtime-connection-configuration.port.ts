import type { ConfigType } from '@nestjs/config';

import {
  type RuntimeConnectionConfiguration,
  appConfig,
} from '@/config/runtime-configuration';

export const RUNTIME_CONNECTION_CONFIGURATION = Symbol(
  'RUNTIME_CONNECTION_CONFIGURATION',
);

export type RuntimeConnectionConfigurationPort = RuntimeConnectionConfiguration;

/**
 * The full validated configuration presentation needs, published by Secrets so
 * guards and controllers do not couple to the global config module. The
 * provider is an alias of appConfig: there is still one validated snapshot.
 */
export const RUNTIME_PRESENTATION_CONFIGURATION = Symbol(
  'RUNTIME_PRESENTATION_CONFIGURATION',
);

export type RuntimePresentationConfiguration = ConfigType<typeof appConfig>;
