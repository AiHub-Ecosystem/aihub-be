'use strict';

const net = require('node:net');
const tls = require('node:tls');

const READINESS_URL = 'http://127.0.0.1:3000/ready';
const PROBE_TIMEOUT_MS = 3_000;
const REQUIRED_READINESS_CHECKS = ['runtime-postgres'];
const READINESS_CHECKS = [
  ...REQUIRED_READINESS_CHECKS,
  'control-plane-write-postgres',
  'control-plane-read-postgres',
  'redis',
];
const DOWNSTREAMS = [
  ['ai-writing', 'DOWNSTREAM_AI_WRITING_URL'],
  ['ai-speaking', 'DOWNSTREAM_AI_SPEAKING_URL'],
];

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'CONNECTION_FAILED';
}

// Provider checks stop at TCP/TLS because grading requests may consume quota.
function probeDependencyUrl(value, timeoutMs = PROBE_TIMEOUT_MS) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return Promise.resolve({ ok: false, result: 'INVALID_URL' });
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return Promise.resolve({ ok: false, result: 'INVALID_URL' });
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const timeout = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);

    function finish(ok, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolve({ ok, result });
    }

    try {
      if (url.protocol === 'https:') {
        const options = { host, port, rejectUnauthorized: true };
        if (net.isIP(host) === 0) options.servername = host;
        socket = tls.connect(options, () => finish(true, 'TLS_CONNECTED'));
      } else {
        socket = net.connect({ host, port }, () =>
          finish(true, 'TCP_CONNECTED'),
        );
      }
      socket.once('error', (error) => finish(false, safeErrorCode(error)));
      socket.setTimeout(timeoutMs, () => finish(false, 'TIMEOUT'));
    } catch (error) {
      finish(false, safeErrorCode(error));
    }
  });
}

async function probeReadiness(fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetchImpl(READINESS_URL, {
      redirect: 'manual',
      signal: controller.signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      return { name: 'postgres-redis', ok: false, result: 'INVALID_RESPONSE' };
    }

    const hasDependencies =
      body &&
      typeof body === 'object' &&
      body.dependencies &&
      typeof body.dependencies === 'object';
    const entries = hasDependencies ? Object.entries(body.dependencies) : [];
    const knownDependencies = entries.every(([name]) =>
      READINESS_CHECKS.includes(name),
    );
    const requiredChecksUp =
      hasDependencies &&
      REQUIRED_READINESS_CHECKS.every(
        (name) => body.dependencies[name] === 'up',
      );
    const nonRedisDependenciesUp = entries
      .filter(([name]) => name !== 'redis')
      .every(([, state]) => state === 'up');
    const redisState = hasDependencies ? body.dependencies.redis : undefined;
    const allUp = entries.every(([, state]) => state === 'up');
    const ready =
      response.status === 200 &&
      body.status === 'ok' &&
      allUp &&
      redisState === 'up';
    // Gateway requests fail open on Redis outages; Postgres checks still gate.
    const redisDegraded =
      response.status === 503 &&
      body.status === 'error' &&
      redisState === 'down' &&
      nonRedisDependenciesUp;
    if (
      !hasDependencies ||
      entries.length === 0 ||
      !knownDependencies ||
      !requiredChecksUp ||
      (!ready && !redisDegraded)
    ) {
      const down = entries
        .filter(([, state]) => state !== 'up')
        .map(([name]) => name)
        .filter((name) => READINESS_CHECKS.includes(name));
      return {
        name: 'postgres-redis',
        ok: false,
        result:
          down.length > 0
            ? `DOWN:${down.join(',')}`
            : response.ok
              ? 'DEPENDENCY_STATUS'
              : `HTTP_${response.status}`,
      };
    }

    return {
      name: 'postgres-redis',
      ok: true,
      result: redisDegraded ? 'REDIS_DOWN_ADVISORY' : 'READY',
    };
  } catch (error) {
    return {
      name: 'postgres-redis',
      ok: false,
      result: error?.name === 'AbortError' ? 'TIMEOUT' : 'REQUEST_FAILED',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeRuntimeDependencies({
  env = process.env,
  fetchImpl = fetch,
  connect = probeDependencyUrl,
} = {}) {
  const readiness = await probeReadiness(fetchImpl);
  const downstream = await Promise.all(
    DOWNSTREAMS.map(async ([name, variable]) => {
      const value = env[variable];
      if (!value) return { name, ok: false, result: 'CONFIG_MISSING' };
      return { name, ...(await connect(value)) };
    }),
  );
  return [readiness, ...downstream];
}

async function main() {
  const results = await probeRuntimeDependencies();
  for (const { name, ok, result } of results) {
    console.log(`${name}: ${ok ? 'PASS' : 'FAIL'} (${result})`);
  }
  if (results.some(({ ok }) => !ok)) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch(() => {
    console.error('runtime dependency probe failed unexpectedly');
    process.exitCode = 1;
  });
}

module.exports = {
  probeDependencyUrl,
  probeReadiness,
  probeRuntimeDependencies,
};
