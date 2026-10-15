const { spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const PROMETHEUS_IMAGE = 'prom/prometheus:v3.13.4';
const BLACKBOX_IMAGE = 'quay.io/prometheus/blackbox-exporter:v0.28.0';
const EXPORTER_PORTS = {
  'node-exporter': 9100,
  cadvisor: 19101,
  'postgres-exporter': 9187,
  'redis-exporter': 9121,
  'blackbox-exporter': 9115,
};
const EXPORTER_SERVICES = Object.keys(EXPORTER_PORTS);

function isPrivateOrLoopbackIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function serviceListenAddress(service) {
  const command = service.command ?? [];
  const webAddress = command.find((value) =>
    value.startsWith('--web.listen-address='),
  );
  if (webAddress) return webAddress.slice('--web.listen-address='.length);

  const bindAddress = command.find((value) => value.startsWith('--listen_ip='));
  const port = command.find((value) => value.startsWith('--port='));
  if (!bindAddress || !port) return undefined;
  return `${bindAddress.slice('--listen_ip='.length)}:${port.slice('--port='.length)}`;
}

function validateExporterCompose(compose) {
  const services = compose?.services;
  if (!services) throw new Error('monitoring Compose services are missing');
  if (
    Object.keys(services).some((name) => !Object.hasOwn(EXPORTER_PORTS, name))
  ) {
    throw new Error('monitoring Compose contains an unchecked service');
  }

  for (const name of EXPORTER_SERVICES) {
    const service = services[name];
    if (!service) throw new Error(`${name} is missing from monitoring Compose`);
    if (service.network_mode !== 'host') {
      throw new Error(
        `${name} must use host networking without published ports`,
      );
    }
    if (Array.isArray(service.ports) && service.ports.length > 0) {
      throw new Error(`${name} must not publish ports`);
    }
    if (service.read_only !== true) {
      throw new Error(`${name} must use a read-only root filesystem`);
    }
    if (!(service.cap_drop ?? []).includes('ALL')) {
      throw new Error(`${name} must drop all Linux capabilities`);
    }
    if (service.privileged === true) {
      throw new Error(`${name} must not run as privileged`);
    }
    if ((service.cap_add ?? []).length > 0) {
      throw new Error(`${name} must not add Linux capabilities`);
    }
    if (!(service.security_opt ?? []).includes('no-new-privileges:true')) {
      throw new Error(`${name} must disable privilege escalation`);
    }
    if (
      name === 'cadvisor' &&
      !(service.profiles ?? []).includes('container-metrics')
    ) {
      throw new Error(
        'cadvisor must stay behind the container-metrics profile',
      );
    }
    if (
      name === 'cadvisor' &&
      !service.volumes?.some(
        (volume) =>
          volume.target === '/var/run/docker.sock' && volume.read_only === true,
      )
    ) {
      throw new Error('cadvisor Docker socket mount must be read-only');
    }

    const address = serviceListenAddress(service);
    const separator = address?.lastIndexOf(':') ?? -1;
    const ip = separator < 0 ? undefined : address.slice(0, separator);
    const port =
      separator < 0 ? undefined : Number(address.slice(separator + 1));
    if (!ip || !isPrivateOrLoopbackIPv4(ip)) {
      throw new Error(
        `${name} listener must use a private or loopback IPv4 address`,
      );
    }
    if (port !== EXPORTER_PORTS[name]) {
      throw new Error(`${name} listener must use port ${EXPORTER_PORTS[name]}`);
    }
  }
  return EXPORTER_SERVICES;
}

function buildMonitoringCheckCommands(repositoryRoot) {
  const monitoringDirectory = path.resolve(repositoryRoot, 'ops/monitoring');
  const composeFile = path.join(monitoringDirectory, 'exporters.compose.yml');
  const envFile = path.join(monitoringDirectory, '.env.example');
  const configMount = `type=bind,source=${monitoringDirectory},target=/etc/prometheus,readonly`;

  return [
    {
      label: 'docker compose monitoring exporters config',
      command: 'docker',
      args: [
        'compose',
        '--env-file',
        envFile,
        '--profile',
        '*',
        '-f',
        composeFile,
        'config',
        '--format',
        'json',
      ],
    },
    {
      label: 'promtool check Prometheus config',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--mount',
        configMount,
        '--entrypoint',
        'promtool',
        PROMETHEUS_IMAGE,
        'check',
        'config',
        '/etc/prometheus/prometheus.yml',
      ],
    },
    {
      label: 'promtool check alert rules',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--mount',
        configMount,
        '--entrypoint',
        'promtool',
        PROMETHEUS_IMAGE,
        'check',
        'rules',
        '/etc/prometheus/alert.rules.yml',
      ],
    },
    {
      label: 'blackbox_exporter check probe config',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--mount',
        configMount,
        '--entrypoint',
        'blackbox_exporter',
        BLACKBOX_IMAGE,
        '--config.check',
        '--config.file=/etc/prometheus/blackbox.yml',
      ],
    },
  ];
}

function runMonitoringChecks(
  execute = spawnSync,
  repositoryRoot = path.resolve(__dirname, '../..'),
) {
  for (const step of buildMonitoringCheckCommands(repositoryRoot)) {
    const isCompose = step.label.startsWith('docker compose');
    const result = execute(
      step.command,
      step.args,
      isCompose ? { encoding: 'utf8', stdio: 'pipe' } : { stdio: 'inherit' },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`${step.label} failed`);
    }
    if (isCompose) {
      try {
        validateExporterCompose(JSON.parse(result.stdout));
      } catch (error) {
        throw new Error(
          `${step.label} failed: ${error instanceof Error ? error.message : 'invalid output'}`,
        );
      }
    }
  }
}

if (require.main === module) {
  try {
    runMonitoringChecks();
    process.stdout.write(
      'Monitoring Compose, Prometheus, and blackbox config checks passed.\n',
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'monitoring config check failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  buildMonitoringCheckCommands,
  isPrivateOrLoopbackIPv4,
  runMonitoringChecks,
  validateExporterCompose,
};
