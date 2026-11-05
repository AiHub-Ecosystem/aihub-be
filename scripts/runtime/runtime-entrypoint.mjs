import { existsSync, writeSync } from 'node:fs';
import process from 'node:process';

const runtimeConnectionModule = new URL(
  '../../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
  import.meta.url,
);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is (options: {env: NodeJS.ProcessEnv, target?: 'runtime' | 'operator'}) => void} */
function isRuntimeConnectionLoader(value) {
  return typeof value === 'function';
}

async function main() {
  // Set only by the scheduled host wrapper; the API entrypoint has no deadline.
  const args = process.argv.slice(2);
  /** @type {number | undefined} */
  let timeoutSeconds;
  if (args[0] === '--timeout-seconds') {
    const rawTimeout = args[1];
    if (rawTimeout === undefined || !/^[1-9]\d*$/.test(rawTimeout)) {
      throw new Error('--timeout-seconds must be a positive integer');
    }
    const seconds = Number(rawTimeout);
    if (!Number.isSafeInteger(seconds) || seconds * 1000 > 2_147_483_647) {
      throw new Error('--timeout-seconds is out of range');
    }
    timeoutSeconds = seconds;
    args.splice(0, 2);
  }
  if (timeoutSeconds !== undefined) {
    const timeout = setTimeout(() => {
      writeSync(2, `scheduled command timed out after ${timeoutSeconds}s\n`);
      process.exit(124);
    }, timeoutSeconds * 1000);
    timeout.unref();
  }

  const target = args[0] ?? 'dist/main.js';
  const connectionTarget =
    target === 'scripts/cli/migrate.mjs' || target === 'scripts/cli/cli.mjs'
      ? 'operator'
      : 'runtime';

  if (!existsSync(runtimeConnectionModule)) {
    throw new Error('runtime connection loader is unavailable');
  }

  const runtimeConnection = /** @type {unknown} */ (
    await import(runtimeConnectionModule)
  );
  const defaultExport = isRecord(runtimeConnection)
    ? runtimeConnection.default
    : undefined;
  const directLoader = isRecord(runtimeConnection)
    ? runtimeConnection.loadRuntimeConnectionEnvironment
    : undefined;
  const defaultLoader = isRecord(defaultExport)
    ? defaultExport.loadRuntimeConnectionEnvironment
    : undefined;
  const loadRuntimeConnectionEnvironment = isRuntimeConnectionLoader(
    directLoader,
  )
    ? directLoader
    : isRuntimeConnectionLoader(defaultLoader)
      ? defaultLoader
      : undefined;
  if (loadRuntimeConnectionEnvironment === undefined) {
    throw new Error('runtime connection loader is unavailable');
  }
  loadRuntimeConnectionEnvironment({
    env: process.env,
    target: connectionTarget,
  });

  args.shift();
  // The target sees its own arguments: `runtime-entrypoint.mjs scripts/cli/cli.mjs
  // avatar:sweep` must reach the CLI as `avatar:sweep`, not as the path of the
  // script being run. Nothing else forwards arguments, so this is how an
  // operator command gets the runtime secrets inside a deployed container.
  process.argv.splice(2, process.argv.length - 2, ...args);

  const targetUrl = new URL(
    target.startsWith('dist/') || target.startsWith('scripts/')
      ? `../../${target}`
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
    `runtime configuration failed: ${error instanceof Error ? error.message : typeof error === 'string' ? error : ''}`,
  );
  process.exitCode = 1;
});
