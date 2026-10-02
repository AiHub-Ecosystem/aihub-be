import { existsSync } from 'node:fs';
import process from 'node:process';

const runtimeConnectionModule = new URL(
  '../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
  import.meta.url,
);

async function main() {
  if (!existsSync(runtimeConnectionModule)) {
    throw new Error('runtime connection loader is unavailable');
  }

  const runtimeConnection = await import(runtimeConnectionModule);
  const loadRuntimeConnectionEnvironment =
    runtimeConnection.loadRuntimeConnectionEnvironment ??
    runtimeConnection.default?.loadRuntimeConnectionEnvironment;
  if (typeof loadRuntimeConnectionEnvironment !== 'function') {
    throw new Error('runtime connection loader is unavailable');
  }
  loadRuntimeConnectionEnvironment();

  const target = process.argv[2] ?? 'dist/main.js';
  // The target sees its own arguments: `runtime-entrypoint.mjs scripts/cli.mjs
  // avatar:sweep` must reach the CLI as `avatar:sweep`, not as the path of the
  // script being run. Nothing else forwards arguments, so this is how an
  // operator command gets the runtime secrets inside a deployed container.
  process.argv.splice(2, 1);

  const targetUrl = new URL(
    target.startsWith('dist/') || target.startsWith('scripts/')
      ? `../${target}`
      : target,
    import.meta.url,
  );
  await import(targetUrl);
}

main().catch((error) => {
  // The message is what an operator reads in the deploy log, so it has to name
  // the failing field or file. "runtime configuration failed" on its own sent
  // every failed sandbox deploy back to the Vault runbook.
  console.error(
    `runtime configuration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
