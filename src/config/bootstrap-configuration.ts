import { loadLocalEnvironment } from './load-local-environment';
import { initializeRuntimeConfiguration } from './runtime-configuration';

export class ConfigurationBootstrapError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : 'runtime configuration failed',
      { cause },
    );
    this.name = 'ConfigurationBootstrapError';
  }
}

export function bootstrapConfiguration(): void {
  try {
    loadLocalEnvironment();
    initializeRuntimeConfiguration();
  } catch (error) {
    throw new ConfigurationBootstrapError(error);
  }
}
