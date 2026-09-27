const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function runnerExports(module) {
  if (typeof module.runSandboxControlPlaneMigrationCli === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runSandboxControlPlaneMigrationCli === 'function'
  ) {
    return module.default;
  }
  throw new Error('Sandbox control-plane migration command is unavailable');
}

async function loadRunner() {
  const builtPath = join(
    __dirname,
    '..',
    'dist',
    'cli',
    'sandbox-control-plane-migration.js',
  );
  if (existsSync(builtPath)) {
    return runnerExports(await import(pathToFileURL(builtPath).href));
  }

  const { register, require: tsxRequire } = require('tsx/cjs/api');
  const unregister = register();
  try {
    return runnerExports(
      tsxRequire(
        join(
          __dirname,
          '..',
          'src',
          'cli',
          'sandbox-control-plane-migration.ts',
        ),
        __filename,
      ),
    );
  } finally {
    unregister();
  }
}

async function main() {
  const runner = await loadRunner();
  await runner.runSandboxControlPlaneMigrationCli({
    argv: process.argv.slice(2),
    sourceUrl: process.env.DATABASE_URL ?? '',
    targetUrl: process.env.CONTROL_PLANE_DATABASE_URL ?? '',
    emit: (line) => console.log(line),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : '';
  if (
    /^(missing required option|unsupported option|--org |sandbox Organization|sandbox Organization must|production control plane|DATABASE_URL and CONTROL_PLANE_DATABASE_URL)/.test(
      message,
    )
  ) {
    console.error(message);
  } else {
    console.error(
      'Sandbox control-plane migration failed; verify source and target state before retrying.',
    );
  }
  process.exitCode = 1;
});
