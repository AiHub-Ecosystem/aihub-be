const { readFileSync } = require('node:fs');

const EXPECTED_GATEWAY = '172.16.7.1';
const EXPECTED_BACKEND_NETWORK = 'aihub-production_backend';
const APP_SERVICES = ['app', 'app-slot-b', 'app-sandbox', 'app-sandbox-slot-b'];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} compose @returns {string[]} */
function validateTrustedProxyCompose(compose) {
  const networks = isRecord(compose) ? compose.networks : undefined;
  const backend = isRecord(networks) ? networks.backend : undefined;
  if (
    !isRecord(backend) ||
    backend.external !== true ||
    backend.name !== EXPECTED_BACKEND_NETWORK
  ) {
    throw new Error(
      `backend network must be externally managed as ${EXPECTED_BACKEND_NETWORK}`,
    );
  }

  const services = isRecord(compose) ? compose.services : undefined;
  for (const name of APP_SERVICES) {
    const service = isRecord(services) ? services[name] : undefined;
    if (!isRecord(service))
      throw new Error(`${name} is missing from production Compose config`);
    const serviceNetworks = isRecord(service.networks) ? service.networks : {};
    if (!Object.hasOwn(serviceNetworks, 'backend')) {
      throw new Error(`${name} must attach to the backend network`);
    }
    const environment = isRecord(service.environment)
      ? service.environment
      : undefined;
    if (environment?.AIHUB_TRUSTED_PROXY_IP !== EXPECTED_GATEWAY) {
      throw new Error(
        `${name} trusted-proxy IP must match the backend gateway`,
      );
    }
  }
  return APP_SERVICES;
}

module.exports = { validateTrustedProxyCompose };

if (require.main === module) {
  try {
    const compose = /** @type {unknown} */ (
      JSON.parse(readFileSync(0, 'utf8'))
    );
    validateTrustedProxyCompose(compose);
    process.stdout.write('production Compose trusted-proxy gateway verified\n');
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
