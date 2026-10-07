const MAX_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 5_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeProductionHealth(hostname) {
  if (!hostname) {
    console.error('AIHUB_PRODUCTION_HOST is required');
    return false;
  }
  const labels = hostname.split('.');
  if (
    hostname.length > 253 ||
    labels.some(
      (label) =>
        label.length > 63 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  ) {
    console.error('AIHUB_PRODUCTION_HOST must be a DNS hostname');
    return false;
  }

  const url = `https://${hostname}/health`;
  const startedAt = performance.now();
  const deadline = startedAt + MAX_WAIT_MS;
  let attempts = 0;
  let lastResult = 'no response';

  while (performance.now() < deadline) {
    attempts += 1;
    const remainingMs = deadline - performance.now();
    const requestTimeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.body) {
        await response.body.cancel().catch(() => undefined);
      }

      if (performance.now() >= deadline) {
        lastResult = 'total deadline exceeded';
      } else if (response.status >= 200 && response.status < 300) {
        const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(
          1,
        );
        console.log(
          `Production health probe passed: HTTP ${response.status}, attempts=${attempts}, elapsed=${elapsedSeconds}s`,
        );
        return true;
      } else {
        lastResult = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastResult =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'request error';
    } finally {
      clearTimeout(timeout);
    }

    console.error(
      `Production health probe attempt ${attempts} failed: ${lastResult}`,
    );

    const remainingAfterAttemptMs = deadline - performance.now();
    if (remainingAfterAttemptMs <= 0) {
      break;
    }
    await sleep(Math.min(RETRY_INTERVAL_MS, remainingAfterAttemptMs));
  }

  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `Production health probe failed: attempts=${attempts}, result=${lastResult}, elapsed=${elapsedSeconds}s`,
  );
  return false;
}

async function main() {
  try {
    process.exitCode = (await probeProductionHealth(
      process.env.AIHUB_PRODUCTION_HOST,
    ))
      ? 0
      : 1;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown error';
    console.error(`Production health probe failed unexpectedly: ${errorName}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = { probeProductionHealth };
