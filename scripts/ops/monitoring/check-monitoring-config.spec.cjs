const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildMonitoringCheckCommands,
  runMonitoringChecks,
  validateExporterCompose,
} = require('./check-monitoring-config.cjs');

function validExporterCompose() {
  const services = {
    'prometheus-aihub': {
      image: 'prom/prometheus:v3.13.4',
      command: [
        '--config.file=/etc/prometheus/prometheus.yml',
        '--storage.tsdb.path=/prometheus',
        '--storage.tsdb.retention.size=512MB',
      ],
      ports: [
        {
          host_ip: '127.0.0.1',
          target: 9090,
          published: '9094',
          protocol: 'tcp',
        },
      ],
      networks: { monitoring: { ipv4_address: '172.27.0.12' } },
      mem_limit: '256m',
      cpus: 0.35,
    },
    'node-exporter': {
      command: ['--web.listen-address=127.0.0.1:9100'],
      network_mode: 'host',
      mem_limit: '96m',
      cpus: 0.1,
    },
    cadvisor: {
      command: ['--listen_ip=127.0.0.1', '--port=19101'],
      network_mode: 'host',
      mem_limit: '192m',
      cpus: 0.25,
      profiles: ['container-metrics'],
      volumes: [
        { target: '/var/run/docker.sock', read_only: true },
        { target: '/run/containerd/containerd.sock', read_only: true },
      ],
    },
    'postgres-exporter': {
      command: ['--web.listen-address=127.0.0.1:9187'],
      network_mode: 'host',
      user: '1000:1000',
      mem_limit: '96m',
      cpus: 0.1,
    },
    'redis-exporter': {
      command: ['--web.listen-address=:9121', '--config-command=-'],
      networks: { monitoring: {}, redis: {} },
      user: '1004:1004',
      environment: { REDIS_ADDR: 'redis://redis:6379' },
      mem_limit: '64m',
      cpus: 0.1,
    },
    'blackbox-exporter': {
      command: ['--web.listen-address=:9115'],
      networks: { monitoring: {} },
      mem_limit: '64m',
      cpus: 0.1,
    },
    'ssh-tunnel': {
      build: { args: { AIHUB_MONITORING_UID_GID: '1004:1004' } },
      network_mode: 'host',
      user: '1004:1004',
      mem_limit: '32m',
      cpus: 0.05,
    },
  };
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, service]) => [
        name,
        {
          ...service,
          read_only: true,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          pids_limit: 64,
        },
      ]),
    ),
  };
}

void test('validates the exporter Compose file and Prometheus config and rules', () => {
  const root = 'D:/repo';
  const directory = path.resolve(root, 'ops/monitoring');
  const mount = `type=bind,source=${directory},target=/etc/prometheus,readonly`;
  const commands = buildMonitoringCheckCommands(root);

  assert.equal(commands.length, 5);
  assert.deepEqual(commands[0], {
    label: 'docker compose monitoring exporters config',
    command: 'docker',
    args: [
      'compose',
      '--env-file',
      path.join(directory, '.env.example'),
      '--profile',
      '*',
      '-f',
      path.join(directory, 'exporters.compose.yml'),
      'config',
      '--format',
      'json',
    ],
  });
  assert.deepEqual(commands[1], {
    label: 'promtool check Prometheus config',
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--mount',
      mount,
      '--entrypoint',
      'promtool',
      'prom/prometheus:v3.13.4',
      'check',
      'config',
      '/etc/prometheus/prometheus.yml',
    ],
  });
  assert.deepEqual(commands[2], {
    label: 'promtool check alert rules',
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--mount',
      mount,
      '--entrypoint',
      'promtool',
      'prom/prometheus:v3.13.4',
      'check',
      'rules',
      '/etc/prometheus/alert.rules.yml',
    ],
  });
  assert.deepEqual(commands[3], {
    label: 'promtool test alert rules',
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--mount',
      mount,
      '--entrypoint',
      'promtool',
      'prom/prometheus:v3.13.4',
      'test',
      'rules',
      '/etc/prometheus/alert.rules.test.yml',
    ],
  });
  assert.deepEqual(commands[4], {
    label: 'blackbox_exporter check probe config',
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--mount',
      mount,
      '--entrypoint',
      'blackbox_exporter',
      'quay.io/prometheus/blackbox-exporter:v0.28.0',
      '--config.check',
      '--config.file=/etc/prometheus/blackbox.yml',
    ],
  });
});

void test('stops at the first invalid monitoring config', () => {
  const executed = [];
  assert.throws(
    () =>
      runMonitoringChecks((command, args) => {
        executed.push([command, args]);
        return {
          status: executed.length === 1 ? 1 : 0,
          error: null,
          stderr: 'compose diagnostic from fixture',
        };
      }, 'D:/repo'),
    /docker compose monitoring exporters config failed: compose diagnostic from fixture/,
  );
  assert.equal(executed.length, 1);
});

void test('accepts loopback or private exporter listeners without published ports', () => {
  assert.deepEqual(validateExporterCompose(validExporterCompose()), [
    'prometheus-aihub',
    'node-exporter',
    'cadvisor',
    'postgres-exporter',
    'redis-exporter',
    'blackbox-exporter',
    'ssh-tunnel',
  ]);
});

void test('reserves the source address used by host firewall rules', () => {
  const compose = validExporterCompose();
  compose.services['prometheus-aihub'].networks.monitoring.ipv4_address =
    '172.27.0.13';
  assert.throws(
    () => validateExporterCompose(compose),
    /reserved monitoring-network address/,
  );
});

void test('requires read-only Docker and containerd sockets for cAdvisor', () => {
  const missingContainerdSocket = validExporterCompose();
  missingContainerdSocket.services.cadvisor.volumes =
    missingContainerdSocket.services.cadvisor.volumes.filter(
      (volume) => volume.target !== '/run/containerd/containerd.sock',
    );
  assert.throws(
    () => validateExporterCompose(missingContainerdSocket),
    /containerd socket mount must be read-only/,
  );

  const writableContainerdSocket = validExporterCompose();
  writableContainerdSocket.services.cadvisor.volumes[1].read_only = false;
  assert.throws(
    () => validateExporterCompose(writableContainerdSocket),
    /containerd socket mount must be read-only/,
  );
});

void test('requires secret-reading services to use non-root host accounts', () => {
  const compose = validExporterCompose();
  compose.services['ssh-tunnel'].user = '0:0';
  assert.throws(
    () => validateExporterCompose(compose),
    /ssh-tunnel must run as a numeric non-root user/,
  );

  const rootPostgres = validExporterCompose();
  rootPostgres.services['postgres-exporter'].user = '0:0';
  assert.throws(
    () => validateExporterCompose(rootPostgres),
    /postgres-exporter must run as a numeric non-root user/,
  );

  const mismatchedRedis = validExporterCompose();
  mismatchedRedis.services['redis-exporter'].user = '1005:1005';
  assert.throws(
    () => validateExporterCompose(mismatchedRedis),
    /redis-exporter must use the monitoring host account/,
  );

  const mismatchedTunnelImage = validExporterCompose();
  mismatchedTunnelImage.services[
    'ssh-tunnel'
  ].build.args.AIHUB_MONITORING_UID_GID = '1005:1005';
  assert.throws(
    () => validateExporterCompose(mismatchedTunnelImage),
    /ssh-tunnel image must create the monitoring host account/,
  );
});

void test('rejects a public listener, published port, or weakened container boundary', () => {
  const compose = validExporterCompose();
  compose.services['node-exporter'].command = [
    '--web.listen-address=0.0.0.0:9100',
  ];

  assert.throws(() => validateExporterCompose(compose), /private or loopback/);

  compose.services['node-exporter'].command = [
    '--web.listen-address=127.0.0.1:9100',
  ];
  compose.services['node-exporter'].privileged = true;
  assert.throws(
    () => validateExporterCompose(compose),
    /must not run as privileged/,
  );

  delete compose.services['node-exporter'].privileged;
  compose.services['node-exporter'].cap_add = ['SYS_ADMIN'];
  assert.throws(
    () => validateExporterCompose(compose),
    /must not add Linux capabilities/,
  );

  delete compose.services['node-exporter'].cap_add;
  compose.services['node-exporter'].ports = ['0.0.0.0:9100:9100'];
  assert.throws(
    () => validateExporterCompose(compose),
    /must not publish ports/,
  );

  delete compose.services['node-exporter'].ports;
  compose.services['node-exporter'].read_only = false;
  assert.throws(() => validateExporterCompose(compose), /read-only/);

  const invalidPort = validExporterCompose();
  invalidPort.services['node-exporter'].command = [
    '--web.listen-address=127.0.0.1:9101',
  ];
  assert.throws(() => validateExporterCompose(invalidPort), /port 9100/);

  const uncheckedService = validExporterCompose();
  uncheckedService.services.unreviewed = {};
  assert.throws(
    () => validateExporterCompose(uncheckedService),
    /unchecked service/,
  );

  const ungatedCadvisor = validExporterCompose();
  ungatedCadvisor.services.cadvisor.profiles = [];
  assert.throws(
    () => validateExporterCompose(ungatedCadvisor),
    /container-metrics profile/,
  );

  const writableSocket = validExporterCompose();
  writableSocket.services.cadvisor.volumes[0].read_only = false;
  assert.throws(
    () => validateExporterCompose(writableSocket),
    /socket mount must be read-only/,
  );

  const publicRedisExporter = validExporterCompose();
  publicRedisExporter.services['redis-exporter'].ports = ['9121:9121'];
  assert.throws(
    () => validateExporterCompose(publicRedisExporter),
    /must not publish ports/,
  );

  const publicPrometheus = validExporterCompose();
  publicPrometheus.services['prometheus-aihub'].ports[0].host_ip = '0.0.0.0';
  assert.throws(
    () => validateExporterCompose(publicPrometheus),
    /must publish only on loopback/,
  );

  const missingRedisNetwork = validExporterCompose();
  delete missingRedisNetwork.services['redis-exporter'].networks.redis;
  assert.throws(
    () => validateExporterCompose(missingRedisNetwork),
    /Redis network/,
  );

  const missingBudget = validExporterCompose();
  delete missingBudget.services['cadvisor'].mem_limit;
  assert.throws(() => validateExporterCompose(missingBudget), /memory limit/);

  const unboundedPrometheusStorage = validExporterCompose();
  unboundedPrometheusStorage.services['prometheus-aihub'].command =
    unboundedPrometheusStorage.services['prometheus-aihub'].command.filter(
      (argument) => !argument.startsWith('--storage.tsdb.retention.size='),
    );
  assert.throws(
    () => validateExporterCompose(unboundedPrometheusStorage),
    /cap TSDB retention/,
  );
});

void test('runs all config checks when each succeeds', () => {
  const executed = [];
  runMonitoringChecks((command, args) => {
    executed.push([command, args]);
    return {
      status: 0,
      error: null,
      stdout:
        executed.length === 1 ? JSON.stringify(validExporterCompose()) : '',
    };
  });
  assert.equal(executed.length, 5);
  assert.equal(
    executed[0][1][2],
    path.resolve(__dirname, '../../../ops/monitoring/.env.example'),
  );
  assert.equal(
    executed[0][1][6],
    path.resolve(__dirname, '../../../ops/monitoring/exporters.compose.yml'),
  );
});
