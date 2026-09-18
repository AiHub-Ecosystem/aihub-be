const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

let runnerPromise;

function runnerExports(module) {
  if (typeof module.runUsagePruneCommand === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runUsagePruneCommand === 'function'
  ) {
    return module.default;
  }
  throw new Error('usage prune command is unavailable');
}

async function loadRunner() {
  if (runnerPromise === undefined) {
    runnerPromise = (async () => {
      const builtPath = join(__dirname, '..', 'dist', 'cli', 'usage-prune.js');
      if (existsSync(builtPath)) {
        return runnerExports(await import(pathToFileURL(builtPath).href));
      }

      const { tsImport } = await import('tsx/esm/api');
      return runnerExports(
        await tsImport(
          pathToFileURL(join(__dirname, '..', 'src', 'cli', 'usage-prune.ts'))
            .href,
          pathToFileURL(__filename).href,
        ),
      );
    })();
  }
  return runnerPromise;
}

async function runUsagePrune(input) {
  const runner = await loadRunner();
  return runner.runUsagePruneCommand(input);
}

module.exports = { runUsagePrune };
