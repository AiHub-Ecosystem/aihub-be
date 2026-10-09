'use strict';

const DEFAULT_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 3_000;

function validateHostname(hostname, label) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error(`${label} hostname is required`);
  }
  const labels = hostname.split('.');
  if (
    hostname.length > 253 ||
    labels.some(
      (part) =>
        part.length > 63 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part),
    )
  ) {
    throw new Error(`${label} hostname must be a DNS hostname`);
  }
  return hostname;
}

async function probeHost(hostname, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`https://${hostname}/health`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.body) {
      void response.body.cancel().catch(() => undefined);
    }
    if (response.status >= 200 && response.status < 300) {
      return { hostname, ok: true, result: `HTTP ${response.status}` };
    }
    return { hostname, ok: false, result: `HTTP ${response.status}` };
  } catch (error) {
    return {
      hostname,
      ok: false,
      result: error instanceof Error ? error.name : 'request error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function startPublicHealthMonitor(
  hosts,
  {
    fetchImpl = fetch,
    intervalMs = DEFAULT_INTERVAL_MS,
    onFailure = () => undefined,
  } = {},
) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('at least one public hostname is required');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error('probe interval must be a positive integer');
  }

  const failures = [];
  let samples = 0;
  let running = true;
  let busy = false;
  let timer;
  let wake;

  const loop = (async () => {
    while (running) {
      const startedAt = performance.now();
      if (!busy) {
        busy = true;
        const results = await Promise.all(
          hosts.map(({ hostname }) => probeHost(hostname, fetchImpl)),
        );
        samples += results.length;
        for (const result of results) {
          if (!result.ok) {
            const failure = {
              hostname: result.hostname,
              result: result.result,
            };
            failures.push(failure);
            onFailure(failure);
          }
        }
        busy = false;
      }

      const remaining = intervalMs - (performance.now() - startedAt);
      if (running && remaining > 0) {
        await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(() => {
            timer = undefined;
            wake = undefined;
            resolve();
          }, remaining);
        });
      }
    }
  })();

  return {
    get failures() {
      return [...failures];
    },
    get samples() {
      return samples;
    },
    async stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        wake?.();
        wake = undefined;
      }
      await loop;
      return { failures: [...failures], samples };
    },
  };
}

async function main() {
  const hosts = [
    {
      tier: 'production',
      hostname: validateHostname(
        process.env.AIHUB_PRODUCTION_HOST,
        'AIHUB_PRODUCTION_HOST',
      ),
    },
  ];
  if (process.env.AIHUB_SANDBOX_ENABLED === 'true') {
    hosts.push({
      tier: 'sandbox',
      hostname: validateHostname(
        process.env.AIHUB_SANDBOX_HOST,
        'AIHUB_SANDBOX_HOST',
      ),
    });
  } else if (
    process.env.AIHUB_SANDBOX_ENABLED !== undefined &&
    process.env.AIHUB_SANDBOX_ENABLED !== 'false'
  ) {
    throw new Error('AIHUB_SANDBOX_ENABLED must be true or false');
  }

  const seconds = Number(process.env.AIHUB_PROBE_WINDOW_SECONDS ?? '1');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error('AIHUB_PROBE_WINDOW_SECONDS must be between 1 and 900');
  }

  const monitor = startPublicHealthMonitor(hosts, {
    onFailure: ({ hostname, result }) =>
      console.error(`Public /health failed for ${hostname}: ${result}`),
  });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  const result = await monitor.stop();
  for (const host of hosts) {
    const count = result.samples / hosts.length;
    const failed = result.failures.filter(
      ({ hostname }) => hostname === host.hostname,
    ).length;
    console.log(
      `${host.tier} public /health probes: samples=${count} failures=${failed}`,
    );
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'health probe failed',
    );
    process.exitCode = 1;
  });
}

module.exports = {
  probeHost,
  startPublicHealthMonitor,
  validateHostname,
};
