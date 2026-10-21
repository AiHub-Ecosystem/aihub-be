import { createPublicKey } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const PROBE_PORT = 39117;
const PROBE_INTERVAL_MS = 100;
const phaseSamples = { idle: emptySamples(), burst: emptySamples() };
let phase = 'off';
let probeInFlight = false;
let chartVerification;
let chartVerificationRequested = false;
let verifyChart;
let queueWaitBaseline = 0;
const requireFromApp = createRequire('/app/package.json');
const importFromApp = (specifier) =>
  import(pathToFileURL(requireFromApp.resolve(specifier)));

export function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  return Number(ordered[Math.ceil(fraction * ordered.length) - 1].toFixed(3));
}

export function summarizeProbeSamples(samples) {
  return {
    dnsLookupSampleCount: samples.dnsLookupMs.length,
    dnsLookupP95Ms: percentile(samples.dnsLookupMs, 0.95),
    jwtVerifySampleCount: samples.jwtVerifyMs.length,
    jwtVerifyP95Ms: percentile(samples.jwtVerifyMs, 0.95),
    probeFailures: samples.failures,
    processRssPeakBytes: samples.processRssPeakBytes,
  };
}

export function parseArgon2QueueMetrics(metricsText) {
  const counter = (name) => {
    const value = new RegExp(`^${name}\\s+([0-9]+(?:\\.[0-9]+)?)$`, 'm').exec(
      metricsText,
    )?.[1];
    return value === undefined ? 0 : Number(value);
  };
  return {
    waits: counter('aihub_argon2_queue_waits_total'),
    refusals: counter('aihub_argon2_queue_refusals_total'),
  };
}

export function parseDownstreamQueued(metricsText) {
  let queued = 0;
  for (const match of metricsText.matchAll(
    /^aihub_downstream_pool_queued(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)$/gm,
  )) {
    queued += Number(match[1]);
  }
  return queued;
}

function emptySamples() {
  return {
    dnsLookupMs: [],
    jwtVerifyMs: [],
    failures: 0,
    processRssPeakBytes: 0,
  };
}

async function timed(operation) {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

async function appMetricsText() {
  const response = await fetch('http://127.0.0.1:3000/metrics');
  if (!response.ok) throw new Error('could not read app metrics');
  return response.text();
}

async function currentArgon2QueueMetrics() {
  return parseArgon2QueueMetrics(await appMetricsText());
}

// The idle window must measure an idle process. A preceding overload stage can
// leave over a hundred requests queued per downstream pool, and draining them
// keeps the CPU-limited process too busy to take idle samples.
async function waitForDownstreamDrain() {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const queued = parseDownstreamQueued(await appMetricsText());
    if (queued === 0 || Date.now() > deadline) return queued;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForArgon2QueueWait() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { waits } = await currentArgon2QueueMetrics();
    if (waits > queueWaitBaseline) return waits;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Argon2 queue wait was not observed during the login burst');
}

async function startProbeServer() {
  const encodedKey = process.env.AIHUB_BENCHMARK_JWT_PRIVATE_KEY_B64;
  if (encodedKey === undefined || encodedKey.length === 0) {
    throw new Error('capacity probe requires the benchmark JWT key');
  }

  const { SignJWT, importPKCS8, importSPKI, jwtVerify } =
    await importFromApp('jose');
  const privateKeyPem = Buffer.from(encodedKey, 'base64').toString('utf8');
  const signingKey = await importPKCS8(privateKeyPem, 'RS256');
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const verificationKey = await importSPKI(publicKeyPem, 'RS256');
  const token = await new SignJWT({ sub: 'capacity-probe' })
    .setProtectedHeader({ alg: 'RS256', kid: 'capacity-probe' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signingKey);

  const [
    { default: sharp },
    { sanitizeWritingChartImage },
    { serializeWritingChartImageProcessing },
  ] = await Promise.all([
    importFromApp('sharp'),
    import(
      '/app/dist/modules/writing/application/writing-chart-image-verifier.js'
    ),
    import(
      '/app/dist/modules/writing/application/writing-chart-image-processing.js'
    ),
  ]);
  const chartBytes = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 20, g: 30, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  verifyChart = () =>
    serializeWritingChartImageProcessing(() =>
      sanitizeWritingChartImage({
        contentType: 'image/png',
        bytes: chartBytes,
      }),
    );

  const interval = setInterval(() => {
    const samplePhase = phase;
    if (samplePhase === 'off' || probeInFlight) return;
    probeInFlight = true;
    const samples = phaseSamples[samplePhase];
    samples.processRssPeakBytes = Math.max(
      samples.processRssPeakBytes,
      process.memoryUsage().rss,
    );
    void Promise.all([
      timed(() => lookup('benchmark-support')),
      timed(() => jwtVerify(token, verificationKey, { algorithms: ['RS256'] })),
    ])
      .then(([dnsLookupMs, jwtVerifyMs]) => {
        samples.dnsLookupMs.push(dnsLookupMs);
        samples.jwtVerifyMs.push(jwtVerifyMs);
        return undefined;
      })
      .catch(() => {
        samples.failures += 1;
        return undefined;
      })
      .finally(() => {
        probeInFlight = false;
      });
  }, PROBE_INTERVAL_MS);
  interval.unref();

  const server = createServer((request, response) => {
    void handleControlRequest(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'contention probe failed' });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROBE_PORT, '127.0.0.1', resolve);
  });
  server.unref();
}

async function handleControlRequest(request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/reset') {
    phase = 'off';
    const downstreamQueued = await waitForDownstreamDrain();
    if (downstreamQueued > 0) {
      sendJson(response, 409, {
        error: 'downstream pools did not drain',
        downstreamQueued,
      });
      return;
    }
    phaseSamples.idle = emptySamples();
    phaseSamples.burst = emptySamples();
    chartVerification = undefined;
    chartVerificationRequested = false;
    queueWaitBaseline = (await currentArgon2QueueMetrics()).waits;
    phase = 'idle';
    sendJson(response, 200, { phase });
    return;
  }
  if (request.url === '/burst') {
    const idle = summarizeProbeSamples(phaseSamples.idle);
    if (idle.dnsLookupSampleCount < 10 || idle.jwtVerifySampleCount < 10) {
      sendJson(response, 409, {
        error: 'insufficient idle probe samples',
        ...idle,
      });
      return;
    }
    phaseSamples.burst = emptySamples();
    const queueMetrics = await currentArgon2QueueMetrics();
    phase = 'burst';
    sendJson(response, 200, { ...idle, queueMetrics });
    return;
  }
  if (request.url === '/chart') {
    if (chartVerificationRequested) {
      sendJson(response, 409, {
        error: 'chart verification already started',
      });
      return;
    }
    chartVerificationRequested = true;
    const queueWaitCount = await waitForArgon2QueueWait();
    const startedAt = new Date().toISOString();
    chartVerification = verifyChart().then((result) => ({
      startedAt,
      completedAt: new Date().toISOString(),
      result: result?.kind ?? 'rejected',
    }));
    sendJson(response, 202, { accepted: true, queueWaitCount, startedAt });
    return;
  }
  if (request.url === '/stop') {
    phase = 'off';
    const chart = await chartVerification;
    const queueMetrics = await currentArgon2QueueMetrics();
    sendJson(response, 200, {
      idle: summarizeProbeSamples(phaseSamples.idle),
      burst: summarizeProbeSamples(phaseSamples.burst),
      chartVerification: chart ?? null,
      queueMetrics,
    });
    return;
  }
  response.writeHead(404).end();
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

if (process.env.AIHUB_ARGON2_PROBE === '1') await startProbeServer();
