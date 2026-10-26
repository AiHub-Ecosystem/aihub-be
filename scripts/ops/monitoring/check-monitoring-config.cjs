const { spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

/** @typedef {{host_ip?: string, target?: string | number, published?: string | number, protocol?: string}} MonitoringPort */
/** @typedef {{target: string, read_only?: boolean}} MonitoringVolume */
/** @typedef {{command?: string[], ports?: (string | MonitoringPort)[], volumes?: MonitoringVolume[], networks?: Record<string, {ipv4_address?: string}>, network_mode?: string, user?: string, build?: {args?: Record<string, string | number>}, environment?: Record<string, string | null>, read_only?: boolean, cap_drop?: string[], privileged?: boolean, cap_add?: string[], security_opt?: string[], profiles?: string[], mem_limit?: string | number, cpus?: string | number, pids_limit?: string | number, image?: string}} MonitoringService */
/** @typedef {{services: Record<string, MonitoringService>}} MonitoringCompose */
/** @typedef {(command: string, args: string[], options: {encoding?: 'utf8', stdio?: 'pipe' | 'inherit'}) => {error?: Error | null, status: number | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null}} MonitoringCommandRunner */

const PROMETHEUS_IMAGE = 'prom/prometheus:v3.13.4';
const BLACKBOX_IMAGE = 'quay.io/prometheus/blackbox-exporter:v0.28.0';
const EXPORTER_PORTS = {
  'prometheus-aihub': 9090,
  'node-exporter': 9100,
  cadvisor: 19101,
  'postgres-exporter': 9187,
  'redis-exporter': 9121,
  'blackbox-exporter': 9115,
};
const EXPORTER_SERVICES = [...Object.keys(EXPORTER_PORTS), 'ssh-tunnel'];
const HOST_NETWORK_SERVICES = [
  'node-exporter',
  'cadvisor',
  'postgres-exporter',
  'ssh-tunnel',
];

/** @param {string | number | undefined} value */
function memoryLimitBytes(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb)?$/i);
  if (!match) return 0;
  const units = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
  };
  return Number(match[1]) * (units[(match[2] ?? 'b').toLowerCase()] ?? 1);
}

/** @param {string} address */
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

/** @param {MonitoringService} service */
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/** @param {unknown} value @returns {value is string | MonitoringPort} */
function isMonitoringPort(value) {
  return (
    typeof value === 'string' ||
    (isRecord(value) &&
      (value.host_ip === undefined || typeof value.host_ip === 'string') &&
      (value.target === undefined ||
        typeof value.target === 'string' ||
        typeof value.target === 'number') &&
      (value.published === undefined ||
        typeof value.published === 'string' ||
        typeof value.published === 'number') &&
      (value.protocol === undefined || typeof value.protocol === 'string'))
  );
}

/** @param {unknown} value @returns {value is MonitoringVolume} */
function isMonitoringVolume(value) {
  return (
    isRecord(value) &&
    typeof value.target === 'string' &&
    (value.read_only === undefined || typeof value.read_only === 'boolean')
  );
}

/** @param {unknown} value @returns {value is MonitoringService} */
function isMonitoringService(value) {
  if (!isRecord(value)) return false;
  const optionalStringFields = ['network_mode', 'user', 'image'];
  if (
    optionalStringFields.some(
      (field) => value[field] !== undefined && typeof value[field] !== 'string',
    )
  ) {
    return false;
  }
  const optionalBooleanFields = ['read_only', 'privileged'];
  if (
    optionalBooleanFields.some(
      (field) =>
        value[field] !== undefined && typeof value[field] !== 'boolean',
    )
  ) {
    return false;
  }
  const optionalStringArrays = [
    'command',
    'cap_drop',
    'cap_add',
    'security_opt',
    'profiles',
  ];
  if (
    optionalStringArrays.some(
      (field) => value[field] !== undefined && !isStringArray(value[field]),
    )
  ) {
    return false;
  }
  if (
    (value.ports !== undefined &&
      (!Array.isArray(value.ports) || !value.ports.every(isMonitoringPort))) ||
    (value.volumes !== undefined &&
      (!Array.isArray(value.volumes) ||
        !value.volumes.every(isMonitoringVolume)))
  ) {
    return false;
  }
  for (const field of ['mem_limit', 'cpus', 'pids_limit']) {
    const limit = value[field];
    if (
      limit !== undefined &&
      typeof limit !== 'string' &&
      typeof limit !== 'number'
    ) {
      return false;
    }
  }
  if (value.networks !== undefined) {
    if (!isRecord(value.networks)) return false;
    for (const network of Object.values(value.networks)) {
      if (
        !isRecord(network) ||
        (network.ipv4_address !== undefined &&
          typeof network.ipv4_address !== 'string')
      ) {
        return false;
      }
    }
  }
  if (value.environment !== undefined) {
    if (!isRecord(value.environment)) return false;
    if (
      Object.values(value.environment).some(
        (entry) => entry !== null && typeof entry !== 'string',
      )
    ) {
      return false;
    }
  }
  if (value.build !== undefined) {
    if (!isRecord(value.build)) return false;
    const args = value.build.args;
    if (
      args !== undefined &&
      (!isRecord(args) ||
        Object.values(args).some(
          (entry) => typeof entry !== 'string' && typeof entry !== 'number',
        ))
    ) {
      return false;
    }
  }
  return true;
}

/** @param {unknown} compose */
function validateExporterCompose(compose) {
  if (!isRecord(compose) || !isRecord(compose.services)) {
    throw new Error('monitoring Compose services are missing');
  }
  /** @type {Record<string, MonitoringService>} */
  const services = {};
  for (const [name, value] of Object.entries(compose.services)) {
    if (!isMonitoringService(value)) {
      throw new Error(`${name} has an invalid monitoring service definition`);
    }
    services[name] = value;
  }
  if (Object.keys(services).some((name) => !EXPORTER_SERVICES.includes(name))) {
    throw new Error('monitoring Compose contains an unchecked service');
  }
  for (const name of ['postgres-exporter', 'redis-exporter', 'ssh-tunnel']) {
    if (!/^[1-9]\d*:[1-9]\d*$/.test(String(services[name]?.user ?? ''))) {
      throw new Error(`${name} must run as a numeric non-root user`);
    }
  }
  if (services['redis-exporter'].user !== services['ssh-tunnel'].user) {
    throw new Error('redis-exporter must use the monitoring host account');
  }
  for (const forward of [':19103:127.0.0.1:19103', ':19104:127.0.0.1:19104']) {
    if (
      !(services['ssh-tunnel'].command ?? []).some((arg) =>
        arg.endsWith(forward),
      )
    ) {
      throw new Error(
        `ssh-tunnel must include the app metrics forward ${forward}`,
      );
    }
  }
  if (
    services['ssh-tunnel'].build?.args?.AIHUB_MONITORING_UID_GID !==
    services['ssh-tunnel'].user
  ) {
    throw new Error('ssh-tunnel image must create the monitoring host account');
  }

  for (const name of EXPORTER_SERVICES) {
    const service = services[name];
    if (!service) throw new Error(`${name} is missing from monitoring Compose`);
    if (HOST_NETWORK_SERVICES.includes(name)) {
      if (service.network_mode !== 'host') {
        throw new Error(`${name} must use host networking`);
      }
    } else if (service.network_mode || !service.networks) {
      throw new Error(`${name} must use its private Docker networks`);
    }
    if (name === 'prometheus-aihub') {
      const [port] = service.ports ?? [];
      const loopbackPort =
        typeof port === 'string'
          ? port === '127.0.0.1:9094:9090'
          : port?.host_ip === '127.0.0.1' &&
            Number(port.target) === 9090 &&
            Number(port.published) === 9094 &&
            (port.protocol ?? 'tcp') === 'tcp';
      if (!loopbackPort || service.ports.length !== 1) {
        throw new Error('prometheus-aihub must publish only on loopback');
      }
      if (service.networks?.monitoring?.ipv4_address !== '172.27.0.12') {
        throw new Error(
          'prometheus-aihub must use its reserved monitoring-network address',
        );
      }
    } else if (Array.isArray(service.ports) && service.ports.length > 0) {
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
    if (
      name === 'cadvisor' &&
      !service.volumes?.some(
        (volume) =>
          volume.target === '/run/containerd/containerd.sock' &&
          volume.read_only === true,
      )
    ) {
      throw new Error('cadvisor containerd socket mount must be read-only');
    }

    if (name === 'redis-exporter') {
      const networkNames = Object.keys(service.networks ?? {});
      if (
        !networkNames.includes('monitoring') ||
        !networkNames.includes('redis')
      ) {
        throw new Error(
          'redis-exporter must join the monitoring and Redis networks',
        );
      }
      if (service.environment?.REDIS_ADDR !== 'redis://redis:6379') {
        throw new Error(
          'redis-exporter must target the observed Redis service',
        );
      }
      if (!(service.command ?? []).includes('--config-command=-')) {
        throw new Error('redis-exporter must not read Redis configuration');
      }
    }

    if (
      name === 'blackbox-exporter' &&
      Object.keys(service.networks ?? {}).join(',') !== 'monitoring'
    ) {
      throw new Error('blackbox-exporter must use only the monitoring network');
    }

    if (memoryLimitBytes(service.mem_limit) <= 0) {
      throw new Error(`${name} must have a memory limit`);
    }
    if (!Number.isFinite(Number(service.cpus)) || Number(service.cpus) <= 0) {
      throw new Error(`${name} must have a CPU limit`);
    }
    if (
      !Number.isInteger(Number(service.pids_limit)) ||
      Number(service.pids_limit) <= 0
    ) {
      throw new Error(`${name} must have a PID limit`);
    }

    if (name === 'prometheus-aihub') {
      if (
        !(service.command ?? []).includes('--storage.tsdb.retention.size=512MB')
      ) {
        throw new Error('prometheus-aihub must cap TSDB retention at 512MB');
      }
      if (
        Object.keys(service.networks ?? {}).join(',') !== 'monitoring' ||
        service.image !== PROMETHEUS_IMAGE ||
        !(service.command ?? []).includes(
          '--config.file=/etc/prometheus/prometheus.yml',
        ) ||
        !(service.command ?? []).includes('--storage.tsdb.path=/prometheus')
      ) {
        throw new Error(
          'prometheus-aihub must use its private config and network',
        );
      }
      if (
        !service.volumes?.some(
          (volume) =>
            volume.target === '/etc/prometheus/sandbox-targets' &&
            volume.read_only === true,
        )
      ) {
        throw new Error(
          'prometheus-aihub must mount the optional Sandbox app targets read-only',
        );
      }
      continue;
    }

    if (name === 'ssh-tunnel') continue;

    const address = serviceListenAddress(service);
    const separator = address?.lastIndexOf(':') ?? -1;
    const ip = separator < 0 ? undefined : address.slice(0, separator);
    const port =
      separator < 0 ? undefined : Number(address.slice(separator + 1));
    if (name === 'redis-exporter' || name === 'blackbox-exporter') {
      const expectedAddress = name === 'redis-exporter' ? ':9121' : ':9115';
      if (address !== expectedAddress) {
        throw new Error(
          `${name} must listen only inside its private Docker network`,
        );
      }
      continue;
    }
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

/** @param {string} repositoryRoot */
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
      label: 'promtool test alert rules',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--mount',
        configMount,
        '--entrypoint',
        'promtool',
        PROMETHEUS_IMAGE,
        'test',
        'rules',
        '/etc/prometheus/alert.rules.test.yml',
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

/**
 * @param {MonitoringCommandRunner} [execute]
 * @param {string} [repositoryRoot]
 */
function runMonitoringChecks(
  execute = /** @type {MonitoringCommandRunner} */ (spawnSync),
  repositoryRoot = path.resolve(__dirname, '../../..'),
) {
  for (const step of buildMonitoringCheckCommands(repositoryRoot)) {
    const isCompose = step.label.startsWith('docker compose');
    const result = execute(
      step.command,
      step.args,
      isCompose ? { encoding: 'utf8', stdio: 'pipe' } : { stdio: 'inherit' },
    );
    if (result.error || result.status !== 0) {
      const stderr =
        typeof result.stderr === 'string'
          ? result.stderr
          : result.stderr?.toString('utf8');
      const detail = result.error?.message ?? stderr?.trim().slice(0, 500);
      throw new Error(`${step.label} failed${detail ? `: ${detail}` : ''}`);
    }
    if (isCompose) {
      try {
        const output =
          typeof result.stdout === 'string'
            ? result.stdout
            : result.stdout?.toString('utf8');
        if (output === undefined) {
          throw new Error('docker compose returned no output');
        }
        validateExporterCompose(JSON.parse(output));
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
