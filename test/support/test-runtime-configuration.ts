import {
  type RuntimeConfiguration,
  replaceRuntimeConfiguration,
} from '@/config/runtime-configuration';

/**
 * The test composition root's runtime configuration (#1551).
 *
 * A Nest spec passes the variables it needs here instead of assigning
 * `process.env`: the values go through the same schema and validation as boot,
 * and `process.env` is left as the Jest setup file made it. The baseline is
 * that setup's environment (test secrets, `NODE_ENV=test`); a value of
 * `undefined` removes a variable from it. Call it before compiling the module
 * under test. It replaces the snapshot, so a consumer that already read the
 * old one does not keep the old values.
 */
export function useTestRuntimeConfiguration(
  overrides: Readonly<Record<string, string | undefined>> = {},
): RuntimeConfiguration {
  return replaceRuntimeConfiguration({ ...process.env, ...overrides });
}
