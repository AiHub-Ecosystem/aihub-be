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
const DOWNSTREAMS = /** @type {const} */ ([
  ['ai-writing', 'DOWNSTREAM_AI_WRITING_URL'],
  ['ai-speaking', 'DOWNSTREAM_AI_SPEAKING_URL'],
]);

/** @typedef {{name: string, ok: boolean, result: string}} ProbeResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} error */
function safeErrorCode(error) {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code
    : 'CONNECTION_FAILED';
}

// Provider checks stop at TCP/TLS because grading requests may consume quota.
/** @param {string} value @param {number} [timeoutMs] @returns {Promise<{ok: boolean, result: string}>} */
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
    /** @type {net.Socket | tls.TLSSocket | undefined} */
    let socket;
    const timeout = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);

    /** @param {boolean} ok @param {string} result */
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

/** @param {typeof fetch} [fetchImpl] @returns {Promise<ProbeResult>} */
async function probeReadiness(fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetchImpl(READINESS_URL, {
      redirect: 'manual',
      signal: controller.signal,
    });
    /** @type {unknown} */
    let body;
    try {
      body = await response.json();
    } catch {
      return { name: 'postgres-redis', ok: false, result: 'INVALID_RESPONSE' };
    }

    const bodyRecord = isRecord(body) ? body : undefined;
    const dependencies =
      bodyRecord && isRecord(bodyRecord.dependencies)
        ? bodyRecord.dependencies
        : undefined;
    const hasDependencies = dependencies !== undefined;
    const entries = dependencies ? Object.entries(dependencies) : [];
    const knownDependencies = entries.every(([name]) =>
      READINESS_CHECKS.includes(name),
    );
    const requiredChecksUp =
      hasDependencies &&
      REQUIRED_READINESS_CHECKS.every((name) => dependencies[name] === 'up');
    const nonRedisDependenciesUp = entries
      .filter(([name]) => name !== 'redis')
      .every(([, state]) => state === 'up');
    const redisState = dependencies?.redis;
    const allUp = entries.every(([, state]) => state === 'up');
    const ready =
      response.status === 200 &&
      bodyRecord?.status === 'ok' &&
      allUp &&
      redisState === 'up';
    // Gateway requests fail open on Redis outages; Postgres checks still gate.
    const redisDegraded =
      response.status === 503 &&
      bodyRecord?.status === 'error' &&
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
    const name = isRecord(error) ? error.name : undefined;
    return {
      name: 'postgres-redis',
      ok: false,
      result: name === 'AbortError' ? 'TIMEOUT' : 'REQUEST_FAILED',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, connect?: (value: string) => Promise<{ok: boolean, result: string}>}} [options]
 * @returns {Promise<ProbeResult[]>}
 */
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
