const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const runnerPromises = new WeakMap();

function runnerExport(module, exportName, unavailableMessage) {
  if (typeof module[exportName] === 'function') {
    return module[exportName];
  }
  if (typeof module.default?.[exportName] === 'function') {
    return module.default[exportName];
  }
  throw new Error(unavailableMessage);
}

async function loadRunnerModule(descriptor) {
  if (existsSync(descriptor.builtPath)) {
    let loadedModule;
    try {
      loadedModule = require(descriptor.builtPath);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'ERR_REQUIRE_ESM') {
        throw error;
      }
      loadedModule = await import(pathToFileURL(descriptor.builtPath).href);
    }
    return runnerExport(
      loadedModule,
      descriptor.exportName,
      descriptor.unavailableMessage,
    );
  }

  const { register, require: tsxRequire } = require('tsx/cjs/api');
  const unregister = register();
  try {
    const module = tsxRequire(descriptor.sourcePath, __filename);
    return runnerExport(
      module,
      descriptor.exportName,
      descriptor.unavailableMessage,
    );
  } finally {
    unregister();
  }
}

function loadCliRunner(descriptor) {
  const cached = runnerPromises.get(descriptor);
  if (cached !== undefined) {
    return cached;
  }
  const promise = loadRunnerModule(descriptor);
  runnerPromises.set(descriptor, promise);
  return promise;
}

module.exports = { loadCliRunner };
