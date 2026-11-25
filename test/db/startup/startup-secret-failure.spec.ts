import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  BUILT_MAIN,
  bootWithEnvironment,
  stopChild,
  waitForExit,
  withBootEnvironment,
} from '../../support/built-app-boot';

// The Vault startup row of the #2019 degraded-mode matrix: a required runtime
// secret that is missing, malformed, or incomplete stops the built app before
// it serves anything. It runs in the database lane because that CI job builds
// `dist` first; the app itself opens no database connection before it fails.

// The CI boot bundle's placeholder secret (scripts/ci/boot/ci-boot-config.cjs).
const PLACEHOLDER_SECRET = 'ci-boot-fake';

type SecretBundle = Record<string, unknown>;

const withBuild = existsSync(BUILT_MAIN) ? describe : describe.skip;

async function bootWithSecrets(
  breakBundle: (bundle: SecretBundle) => string,
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  return withBootEnvironment(
    async ({ directory, environment, runtimeSecretsFile }) => {
      // The database Jest lane sets NODE_ENV=test and secret-source=env in its
      // setup file. The built app must read the rendered agent files instead.
      const bootEnvironment = {
        ...environment,
        NODE_ENV: 'development',
        AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
      };
      const bundle = JSON.parse(
        readFileSync(runtimeSecretsFile, 'utf8'),
      ) as SecretBundle;
      writeFileSync(runtimeSecretsFile, breakBundle(bundle));
      const { child, logs } = await bootWithEnvironment(
        bootEnvironment,
        directory,
      );
      try {
        return { exitCode: await waitForExit(child, logs), output: logs() };
      } finally {
        await stopChild(child);
      }
    },
  );
}

withBuild('startup with a broken runtime-secret bundle', () => {
  it.each<[string, (bundle: SecretBundle) => string]>([
    [
      'a missing required secret',
      ({ resend: _resend, ...rest }) => JSON.stringify(rest),
    ],
    [
      'an incomplete required secret',
      (bundle) => JSON.stringify({ ...bundle, 'ai-writing': {} }),
    ],
    ['a malformed bundle', () => '{"ai-writing": '],
  ])(
    'exits with a safe configuration error before listening on %s',
    async (_label, breakBundle) => {
      const { exitCode, output } = await bootWithSecrets(breakBundle);

      expect(exitCode).not.toBe(0);
      // The secrets provider refuses the bundle while the module is built.
      expect(output).toContain('RuntimeSecretConfigurationError');
      // It never reached the point where it serves requests.
      expect(output).not.toContain('Nest application successfully started');
      // The error names what is wrong, never a secret value.
      expect(output).not.toContain(PLACEHOLDER_SECRET);
    },
    90_000,
  );
});
