const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const { usageError } = require('./cli-options.cjs');

let runnerPromise;

function runnerExports(module) {
  if (typeof module.runQuotaReconciliationCommand === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runQuotaReconciliationCommand === 'function'
  ) {
    return module.default;
  }
  throw new Error('quota reconciliation command is unavailable');
}

async function loadRunner() {
  if (runnerPromise === undefined) {
    runnerPromise = (async () => {
      const builtPath = join(
        __dirname,
        '..',
        'dist',
        'cli',
        'quota-reconcile.js',
      );
      if (existsSync(builtPath)) {
        return runnerExports(await import(pathToFileURL(builtPath).href));
      }

      const { tsImport } = await import('tsx/esm/api');
      return runnerExports(
        await tsImport(
          pathToFileURL(
            join(__dirname, '..', 'src', 'cli', 'quota-reconcile.ts'),
          ).href,
          pathToFileURL(__filename).href,
        ),
      );
    })();
  }
  return runnerPromise;
}

function invalidMonth(error) {
  return (
    error instanceof Error &&
    error.name === 'InvalidQuotaReconciliationMonthError'
  );
}

async function parseTargetMonth(raw, now) {
  try {
    const runner = await loadRunner();
    return await runner.parseTargetMonth(raw, now);
  } catch (error) {
    if (invalidMonth(error)) {
      usageError();
    }
    throw error;
  }
}

async function runQuotaReconciliation(input) {
  try {
    const runner = await loadRunner();
    return await runner.runQuotaReconciliationCommand(input);
  } catch (error) {
    if (invalidMonth(error)) {
      usageError();
    }
    throw error;
  }
}

module.exports = { parseTargetMonth, runQuotaReconciliation };
