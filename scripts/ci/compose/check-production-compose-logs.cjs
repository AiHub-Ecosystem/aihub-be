const { readFileSync } = require('node:fs');

const JSON_FILE_OPTIONS = { 'max-size': '10m', 'max-file': '3' };
const APP_SERVICES = {
  app: 'aihub-production',
  'app-slot-b': 'aihub-production',
  'app-sandbox': 'aihub-sandbox',
  'app-sandbox-slot-b': 'aihub-sandbox',
};
const SYSLOG_OPTIONS = {
  'syslog-address': 'tcp://127.0.0.1:1514',
  'syslog-format': 'rfc5424micro',
  'cache-disabled': 'true',
  mode: 'non-blocking',
  'max-buffer-size': '1m',
};

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
  for (const name of Object.keys(APP_SERVICES)) {
    if (!Object.hasOwn(services, name)) {
      throw new Error(
        `production Compose config is missing app service ${name}`,
      );
    }
  }
  for (const name of names) {
    const service = services[name];
    const logging = isRecord(service) ? service.logging : undefined;
    if (!isRecord(logging)) {
      throw new Error(`${name} is missing bounded container logging`);
    }
    const appTag = Object.entries(APP_SERVICES).find(
      ([appService]) => appService === name,
    )?.[1];
    const expectedDriver = appTag !== undefined ? 'syslog' : 'json-file';
    if (logging.driver !== expectedDriver) {
      throw new Error(`${name} must use the ${expectedDriver} log driver`);
    }
    const options = isRecord(logging.options) ? logging.options : undefined;
    const expectedOptions =
      appTag !== undefined
        ? { ...SYSLOG_OPTIONS, tag: appTag }
        : JSON_FILE_OPTIONS;
    if (
      !options ||
      Object.keys(options).length !== Object.keys(expectedOptions).length
    ) {
      throw new Error(`${name} has unexpected logging options`);
    }
    for (const [option, value] of Object.entries(expectedOptions)) {
      if (options[option] !== value) {
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
