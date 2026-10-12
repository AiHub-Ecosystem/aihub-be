const { readFileSync } = require('node:fs');

const EXPECTED_OPTIONS = { 'max-size': '10m', 'max-file': '3' };

function validateProductionCompose(compose) {
  const services = compose?.services;
  if (!services || Object.keys(services).length === 0) {
    throw new Error('production Compose config has no services');
  }

  const names = Object.keys(services).sort();
  for (const name of names) {
    const logging = services[name]?.logging;
    if (!logging) {
      throw new Error(`${name} is missing bounded container logging`);
    }
    if (logging.driver !== 'json-file') {
      throw new Error(`${name} must use the json-file log driver`);
    }
    for (const [option, value] of Object.entries(EXPECTED_OPTIONS)) {
      if (logging.options?.[option] !== value) {
        throw new Error(`${name} must set logging option ${option}=${value}`);
      }
    }
  }

  return names;
}

module.exports = { validateProductionCompose };

if (require.main === module) {
  try {
    const compose = JSON.parse(readFileSync(0, 'utf8'));
    const services = validateProductionCompose(compose);
    process.stdout.write(
      `production Compose log bounds verified for ${services.length} services: ${services.join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
