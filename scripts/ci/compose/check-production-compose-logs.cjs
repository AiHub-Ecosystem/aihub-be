const { readFileSync } = require('node:fs');

const EXPECTED_OPTIONS = { 'max-size': '10m', 'max-file': '3' };

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} compose @returns {string[]} */
function validateProductionCompose(compose) {
  const services = isRecord(compose) ? compose.services : undefined;
  if (!isRecord(services) || Object.keys(services).length === 0) {
    throw new Error('production Compose config has no services');
  }

  const names = Object.keys(services).sort();
  for (const name of names) {
    const service = services[name];
    const logging = isRecord(service) ? service.logging : undefined;
    if (!isRecord(logging)) {
      throw new Error(`${name} is missing bounded container logging`);
    }
    if (logging.driver !== 'json-file') {
      throw new Error(`${name} must use the json-file log driver`);
    }
    for (const [option, value] of Object.entries(EXPECTED_OPTIONS)) {
      const options = isRecord(logging.options) ? logging.options : undefined;
      if (options?.[option] !== value) {
        throw new Error(`${name} must set logging option ${option}=${value}`);
      }
    }
  }

  return names;
}

module.exports = { validateProductionCompose };

if (require.main === module) {
  try {
    const compose = /** @type {unknown} */ (
      JSON.parse(readFileSync(0, 'utf8'))
    );
    const services = validateProductionCompose(compose);
    process.stdout.write(
      `production Compose log bounds verified for ${services.length} services: ${services.join(', ')}\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
