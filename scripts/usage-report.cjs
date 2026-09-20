const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const { usageError } = require('./cli-options.cjs');

const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

let runnerPromise;

function runnerExports(module) {
  if (typeof module.runUsageReportCommand === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runUsageReportCommand === 'function'
  ) {
    return module.default;
  }
  throw new Error('usage report command is unavailable');
}

async function loadRunner() {
  if (runnerPromise === undefined) {
    runnerPromise = (async () => {
      const builtPath = join(__dirname, '..', 'dist', 'cli', 'usage-report.js');
      if (existsSync(builtPath)) {
        return runnerExports(await import(pathToFileURL(builtPath).href));
      }

      const { register, require: tsxRequire } = require('tsx/cjs/api');
      const unregister = register();
      try {
        return runnerExports(
          tsxRequire(
            join(__dirname, '..', 'src', 'cli', 'usage-report.ts'),
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

function invalidWindow(error) {
  return (
    error instanceof Error &&
    error.message === 'usage report window is invalid' &&
    error.code === 'USAGE_REPORT_INVALID_WINDOW'
  );
}

function validateTimestampShape(value) {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) {
    usageError();
  }
}

async function runUsageReport(input) {
  validateTimestampShape(input.from);
  validateTimestampShape(input.to);
  try {
    const runner = await loadRunner();
    return await runner.runUsageReportCommand(input);
  } catch (error) {
    if (invalidWindow(error)) {
      usageError();
    }
    throw error;
  }
}

module.exports = { runUsageReport };
