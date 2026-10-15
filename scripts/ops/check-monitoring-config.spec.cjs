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
    'node-exporter': ['--web.listen-address=127.0.0.1:9100'],
    cadvisor: ['--listen_ip=127.0.0.1', '--port=19101'],
    'postgres-exporter': ['--web.listen-address=192.168.1.5:9187'],
    'redis-exporter': ['--web.listen-address=127.0.0.1:9121'],
    'blackbox-exporter': ['--web.listen-address=172.16.0.1:9115'],
  };
  return {
    services: Object.fromEntries(
      Object.entries(services).map(([name, command]) => [
        name,
        {
          command,
          network_mode: 'host',
          read_only: true,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          pids_limit: 64,
          ...(name === 'cadvisor'
            ? {
                profiles: ['container-metrics'],
                volumes: [{ target: '/var/run/docker.sock', read_only: true }],
              }
            : {}),
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

  assert.equal(commands.length, 4);
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
        return { status: executed.length === 1 ? 1 : 0, error: null };
      }, 'D:/repo'),
    /docker compose monitoring exporters config failed/,
  );
  assert.equal(executed.length, 1);
});

void test('accepts loopback or private exporter listeners without published ports', () => {
  assert.deepEqual(validateExporterCompose(validExporterCompose()), [
    'node-exporter',
    'cadvisor',
    'postgres-exporter',
    'redis-exporter',
    'blackbox-exporter',
  ]);
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
  }, 'D:/repo');
  assert.equal(executed.length, 4);
});
