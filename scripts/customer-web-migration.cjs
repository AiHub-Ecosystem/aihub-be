const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

let runnerPromise;

function runnerExports(module) {
  if (typeof module.runCustomerWebMigrationCli === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runCustomerWebMigrationCli === 'function'
  ) {
    return module.default;
  }
  throw new Error('customer web migration command is unavailable');
}

async function loadRunner() {
  if (runnerPromise === undefined) {
    runnerPromise = (async () => {
      const builtPath = join(
        __dirname,
        '..',
        'dist',
        'cli',
        'customer-web-migration-cli.js',
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
              'customer-web-migration-cli.ts',
            ),
            __filename,
          ),
        );
      } finally {
        unregister();
      }
    })();
  }
  return runnerPromise;
}

async function main() {
  const runner = await loadRunner();
  const outcome = await runner.runCustomerWebMigrationCli({
    argv: process.argv.slice(2),
    databaseUrl: process.env.DATABASE_URL ?? '',
    emit: (line) => console.log(line),
  });
  if (outcome === 'blocked_quarantine') {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
