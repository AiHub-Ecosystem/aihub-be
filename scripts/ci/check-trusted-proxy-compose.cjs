const { readFileSync } = require('node:fs');

const EXPECTED_GATEWAY = '172.16.7.1';
const EXPECTED_BACKEND_NETWORK = 'aihub-production_backend';
const APP_SERVICES = ['app', 'app-slot-b', 'app-sandbox', 'app-sandbox-slot-b'];

function validateTrustedProxyCompose(compose) {
  const backend = compose?.networks?.backend;
  if (
    backend?.external !== true ||
    backend?.name !== EXPECTED_BACKEND_NETWORK
  ) {
    throw new Error(
      `backend network must be externally managed as ${EXPECTED_BACKEND_NETWORK}`,
    );
  }

  const services = compose?.services;
  for (const name of APP_SERVICES) {
    const service = services?.[name];
    if (!service)
      throw new Error(`${name} is missing from production Compose config`);
    if (!Object.hasOwn(service.networks ?? {}, 'backend')) {
      throw new Error(`${name} must attach to the backend network`);
    }
    if (service.environment?.AIHUB_TRUSTED_PROXY_IP !== EXPECTED_GATEWAY) {
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
    const compose = JSON.parse(readFileSync(0, 'utf8'));
    validateTrustedProxyCompose(compose);
    process.stdout.write('production Compose trusted-proxy gateway verified\n');
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
