const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

/** @typedef {import('./load-cli-runner.cjs').CliRunner} CliRunner */
/**
 * @template {CliRunner} T
 * @typedef {import('./load-cli-runner.cjs').CliRunnerDescriptor<T>} CliRunnerDescriptor
 */

/** @type {WeakMap<object, Promise<CliRunner>>} */
const runnerPromises = new WeakMap();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @template {CliRunner} T
 * @param {unknown} moduleValue
 * @param {string} exportName
 * @param {string} unavailableMessage
 * @returns {T}
 */
function runnerExport(moduleValue, exportName, unavailableMessage) {
  if (!isRecord(moduleValue)) {
    throw new Error(unavailableMessage);
  }

  const namedExport = moduleValue[exportName];
  const defaultExport = moduleValue.default;
  const defaultValue = isRecord(defaultExport)
    ? defaultExport[exportName]
    : undefined;
  const candidate = namedExport ?? defaultValue;
  if (typeof candidate === 'function') {
    // The descriptor's generic type is bound to its source export at the call site.
    return /** @type {T} */ (candidate);
  }
  throw new Error(unavailableMessage);
}

/**
 * @template {CliRunner} T
 * @param {CliRunnerDescriptor<T>} descriptor
 * @returns {Promise<T>}
 */
async function loadRunnerModule(descriptor) {
  if (existsSync(descriptor.builtPath)) {
    /** @type {unknown} */
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

  const tsxApi = /** @type {typeof import('tsx/cjs/api')} */ (
    require('tsx/cjs/api')
  );
  const { register, require: tsxRequire } = tsxApi;
  const unregister = register();
  try {
    /** @type {unknown} */
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

/**
 * @template {CliRunner} T
 * @param {CliRunnerDescriptor<T>} descriptor
 * @returns {Promise<T>}
 */
function loadCliRunner(descriptor) {
  const cached = runnerPromises.get(descriptor);
  if (cached !== undefined) {
    return /** @type {Promise<T>} */ (cached);
  }
  const promise = loadRunnerModule(descriptor);
  runnerPromises.set(descriptor, promise);
  return promise;
}

module.exports = { loadCliRunner };
