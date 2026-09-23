const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

let runnerPromise;

function runnerExports(module) {
  if (typeof module.runAttachFirstOwnerCommand === 'function') {
    return module;
  }
  if (
    module.default !== undefined &&
    typeof module.default.runAttachFirstOwnerCommand === 'function'
  ) {
    return module.default;
  }
  throw new Error('first owner attachment command is unavailable');
}

async function loadRunner() {
  if (runnerPromise === undefined) {
    runnerPromise = (async () => {
      const builtPath = join(
        __dirname,
        '..',
        'dist',
        'cli',
        'organization-first-owner.js',
      );
      if (existsSync(builtPath)) {
        return runnerExports(await import(pathToFileURL(builtPath).href));
      }

      const { register, require: tsxRequire } = require('tsx/cjs/api');
      const unregister = register();
      try {
        return runnerExports(
          tsxRequire(
            join(__dirname, '..', 'src', 'cli', 'organization-first-owner.ts'),
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

async function runAttachFirstOwner(input) {
  const runner = await loadRunner();
  return runner.runAttachFirstOwnerCommand(input);
}

module.exports = { runAttachFirstOwner };
