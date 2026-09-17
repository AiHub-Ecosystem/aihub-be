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

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

async function parseTargetMonth(raw, now) {
  // Shape is checked before the runner is loaded, because loading it is the
  // part that can fail for reasons unrelated to the argument: it imports the
  // built output when present and transpiles the TypeScript source when not,
  // and either path can throw something that is not an invalid-month error.
  // Reported as a usage error, that would surface as an operational failure
  // instead — which is what made the "before opening infrastructure" test
  // pass locally, where `dist/` existed, and fail in CI, where it did not.
  //
  // This duplicates the shape rule the runner also enforces, deliberately.
  // The runner still owns the real parse, including the range checks this
  // cannot make without a clock.
  if (raw !== undefined && !MONTH_PATTERN.test(raw)) {
    usageError();
  }

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
