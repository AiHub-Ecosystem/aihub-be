/// <reference path="./capacity-benchmark-k6.d.ts" />

import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';
import {
  K6_GRACEFUL_STOP_SECONDS,
  authAndGradingWorkload,
  gradingRouteDeadlinesMs,
  hasOneUserPerVu,
  isGradingRouteName,
  task1PayloadFromFixture,
} from './capacity-benchmark-utils.mjs';

/** @typedef {'writing_task1' | 'writing_task2' | 'speaking_multipart' | 'speaking_json'} GradingRouteName */
/** @typedef {GradingRouteName | 'login' | 'refresh' | 'web_session_exchange'} RouteName */
/** @typedef {{userId: string, email: string, password: string, refreshToken: string, webSessionToken: string}} BenchmarkUser */
/** @typedef {{apiKey: string}} BenchmarkOrganization */
/** @typedef {{users: BenchmarkUser[], organizations: BenchmarkOrganization[]}} BenchmarkCredentials */
/** @typedef {{status: number, error_code: number, error: unknown, timings: {duration: number}, headers: Record<string, string | string[] | undefined>, body: string}} HttpResponse */

/** @type {RouteName[]} */
const allRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
  'login',
  'refresh',
  'web_session_exchange',
];
/** @type {GradingRouteName[]} */
const gradingRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];
/** @type {Record<RouteName, import('k6/metrics').Counter>} */
const routeResponseCounts = {};
/** @type {Record<RouteName, import('k6/metrics').Counter>} */
const routeErrorCounts = {};
/** @type {Record<RouteName, import('k6/metrics').Counter>} */
const routeTransportErrorCounts = {};
/** @type {Record<GradingRouteName, import('k6/metrics').Counter>} */
const routeGoodputCounts = {};
for (const name of allRoutes) {
  routeResponseCounts[name] = new Counter(`benchmark_api_responses_${name}`);
  routeErrorCounts[name] = new Counter(`benchmark_api_errors_${name}`);
  routeTransportErrorCounts[name] = new Counter(
    `benchmark_api_transport_errors_${name}`,
  );
}
for (const name of gradingRoutes) {
  routeGoodputCounts[name] = new Counter(`benchmark_api_goodput_${name}`);
}
const goodputBySecond = new Counter('benchmark_goodput_by_second');
const probeLatencies = {
  health: new Trend('benchmark_probe_latency_health', true),
  readiness: new Trend('benchmark_probe_latency_readiness', true),
};
const probeFailures = {
  health: new Counter('benchmark_probe_failures_health'),
  readiness: new Counter('benchmark_probe_failures_readiness'),
};
/** @template {string} T @param {T[]} names @param {string} prefix @param {boolean} isTime @returns {Record<T, import('k6/metrics').Trend>} */
function trends(names, prefix, isTime) {
  /** @type {Record<string, import('k6/metrics').Trend>} */
  const result = {};
  for (const name of names) {
    result[name] = new Trend(`${prefix}${name}`, isTime);
  }
  return result;
}
const apiLatency = trends(allRoutes, 'benchmark_latency_', true);
// Accepted (2xx) responses only, so a fast refusal cannot improve a percentile.
const acceptedLatency = trends(allRoutes, 'benchmark_accepted_latency_', true);
const gatewayTotal = trends(gradingRoutes, 'benchmark_gateway_total_', true);
const downstream = trends(gradingRoutes, 'benchmark_downstream_', true);
const processRss = new Gauge('benchmark_process_rss_bytes');
const processHeap = new Gauge('benchmark_process_heap_bytes');
const eventLoopLag = new Gauge('benchmark_event_loop_lag_seconds');
const postgresWaiting = new Gauge('benchmark_postgres_waiting');
const downstreamQueued = new Gauge('benchmark_downstream_queued');

const task1 = task1PayloadFromFixture(
  parseTask1Fixture(
    JSON.parse(open('/fixtures/ai-writing/grade-task1.request.json')),
  ),
);
const task2 = parseJsonObject(
  open('/fixtures/ai-writing/grade-task2.request.json'),
);
const credentials = parseBenchmarkCredentials(
  JSON.parse(open('/data/credentials.json')),
);
const host = 'api.benchmark.test';
const baseUrl = 'http://aihub:3000';
const stubUrl = 'http://benchmark-support:8080';
const bffSecret = 'benchmark-web-session-secret';
const refreshCookieName = '__Host-aihub_refresh';
const speakingJson = {
  audio_url: 'https://s3.wispace.app/benchmark/audio.wav',
  part: 1,
  question_id: 'capacity_benchmark_p1',
  prompt_text: 'Describe a familiar place.',
  test_type: 'Practice',
};
const speakingAudio = new Uint8Array(1024);
const speakingMultipart = {
  audio: http.file(speakingAudio, 'benchmark.wav', 'audio/wav'),
  part: '1',
  question_id: 'capacity_benchmark_p1',
  prompt_text: 'Describe a familiar place.',
  test_type: 'Practice',
};

const workload =
  /** @type {RouteName | 'mixed_grading' | 'auth_and_grading'} */ (
    __ENV.WORKLOAD || 'mixed_grading'
  );
const rate = Number(__ENV.RATE || 4);
const duration = __ENV.DURATION || '15s';
const durationSeconds = Number.parseInt(duration, 10);
const isRecovery = __ENV.IS_RECOVERY === 'true';
const maxVUs = Number(__ENV.MAX_VUS || 256);
const metricsScenarioVUs = 1;

export const options = {
  summaryTrendStats: ['min', 'med', 'avg', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.min(maxVUs, Math.max(16, rate * 3)),
      maxVUs,
      gracefulStop: `${K6_GRACEFUL_STOP_SECONDS}s`,
      exec: 'load',
    },
    metrics: {
      executor: 'constant-arrival-rate',
      startTime: '0s',
      rate: 1,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: metricsScenarioVUs,
      maxVUs: metricsScenarioVUs,
      gracefulStop: '5s',
      exec: 'scrapeMetrics',
    },
    health: {
      executor: 'constant-arrival-rate',
      startTime: '0s',
      rate: 1,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 1,
      maxVUs: 1,
      gracefulStop: '5s',
      exec: 'probeHealth',
    },
    readiness: {
      executor: 'constant-arrival-rate',
      startTime: '0s',
      rate: 1,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 1,
      maxVUs: 1,
      gracefulStop: '5s',
      exec: 'probeReadiness',
    },
  },
  thresholds: {},
};

/** @type {GradingRouteName[]} */
const grading = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];
/** @returns {BenchmarkCredentials} */
export function setup() {
  if (
    !hasOneUserPerVu(
      maxVUs + metricsScenarioVUs,
      credentials.users?.length ?? 0,
    )
  ) {
    throw new Error('benchmark seed must provide one user per k6 VU');
  }
  const reset = http.post(`${stubUrl}/__stats/reset`, null, {
    timeout: '5s',
  });
  if (reset.status !== 204) throw new Error('could not reset benchmark stub');
  return credentials;
}

/** @type {string | undefined} */
let refreshToken;

/** @param {BenchmarkCredentials} data */
export function load(data) {
  if (exec.scenario.iterationInTest === 0) {
    console.log('BENCHMARK_LOAD_STARTED');
  }
  const index = exec.vu.idInTest - 1;
  const user = data.users[index];
  const organization = data.organizations[index % data.organizations.length];
  if (user === undefined || organization === undefined) {
    throw new Error('benchmark credential seed is incomplete');
  }
  if (refreshToken === undefined) refreshToken = user.refreshToken;

  let selected = workload;
  if (workload === 'mixed_grading') {
    selected = grading[exec.scenario.iterationInTest % grading.length];
  } else if (workload === 'auth_and_grading') {
    selected =
      authAndGradingWorkload[
        exec.scenario.iterationInTest % authAndGradingWorkload.length
      ];
  }

  if (selected === 'login') return requestLogin(user);
  if (selected === 'refresh') return requestRefresh(user);
  if (selected === 'web_session_exchange') return requestWebSession(user);
  return requestGrade(selected, organization, user);
}

export function scrapeMetrics() {
  const response = http.get(`${baseUrl}/metrics`, {
    tags: { name: 'metrics' },
  });
  if (response.status !== 200) return;
  for (const line of response.body.split('\n')) {
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/,
    );
    if (match === null) continue;
    const [, name, , rawValue] = match;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (name === 'aihub_process_resident_memory_bytes') processRss.add(value);
    if (name === 'aihub_process_heap_used_bytes') processHeap.add(value);
    if (name === 'aihub_event_loop_lag_seconds') eventLoopLag.add(value);
    if (name === 'aihub_postgres_pool_waiting') postgresWaiting.add(value);
    if (name === 'aihub_downstream_pool_queued') downstreamQueued.add(value);
  }
}

export function probeHealth() {
  recordProbe('health', '/health');
}

export function probeReadiness() {
  recordProbe('readiness', '/ready');
}

export function teardown() {
  const stats = http.get(`${stubUrl}/__stats`, { timeout: '5s' });
  if (stats.status === 200) {
    console.log(`BENCHMARK_STUB_STATS ${stats.body}`);
  }
}

/** @param {{state: unknown, metrics: Record<string, unknown>}} data */
export function handleSummary(data) {
  const summary = { state: data.state, metrics: data.metrics };
  return {
    stdout: `BENCHMARK_SUMMARY_JSON ${JSON.stringify(summary)}\n`,
  };
}

/** @param {GradingRouteName} name @param {BenchmarkOrganization} organization @param {BenchmarkUser} user @returns {HttpResponse} */
function requestGrade(name, organization, user) {
  const route = {
    writing_task1: {
      path: '/v1/ielts/writing/task1/grade',
      body: task1,
    },
    writing_task2: {
      path: '/v1/ielts/writing/task2/grade',
      body: task2,
    },
    speaking_multipart: {
      path: '/v1/ielts/speaking/grading',
      body: speakingMultipart,
    },
    speaking_json: {
      path: '/v1/ielts/speaking/grading-json',
      body: speakingJson,
    },
  }[name];
  if (route === undefined) throw new Error(`unknown grading route ${name}`);
  const headers = {
    Host: host,
    'X-API-Key': organization.apiKey,
    'X-User-Identity': `capacity-user-${user.userId}`,
    'Idempotency-Key': `capacity-${__VU}-${__ITER}-${Date.now()}`,
  };
  const response =
    name === 'speaking_multipart'
      ? http.post(`${baseUrl}${route.path}`, route.body, { headers })
      : http.post(`${baseUrl}${route.path}`, JSON.stringify(route.body), {
          headers: Object.assign({}, headers, {
            'Content-Type': 'application/json',
          }),
        });
  recordResponse(name, response);
  if (response.status >= 200 && response.status < 300) {
    const payload = parseJson(response.body);
    if (
      isRecord(payload) &&
      isRecord(payload.meta) &&
      isRecord(payload.meta.timing)
    ) {
      const timing = payload.meta.timing;
      if (
        typeof timing.total_ms === 'number' &&
        Number.isFinite(timing.total_ms)
      ) {
        gatewayTotal[name].add(timing.total_ms);
      }
      if (
        typeof timing.downstream_ms === 'number' &&
        Number.isFinite(timing.downstream_ms)
      ) {
        downstream[name].add(timing.downstream_ms);
      }
    }
  }
  return response;
}

/** @param {BenchmarkUser} user @returns {HttpResponse} */
function requestLogin(user) {
  const response = http.post(
    `${baseUrl}/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { Host: host, 'Content-Type': 'application/json' } },
  );
  captureRefreshToken(response);
  recordResponse('login', response);
  return response;
}

/** @param {BenchmarkUser} user @returns {HttpResponse} */
function requestRefresh(user) {
  const response = http.post(`${baseUrl}/v1/auth/refresh`, '{}', {
    headers: {
      Host: host,
      'Content-Type': 'application/json',
      Cookie: `${refreshCookieName}=${refreshToken || user.refreshToken}`,
    },
  });
  captureRefreshToken(response);
  recordResponse('refresh', response);
  return response;
}

/** @param {BenchmarkUser} user @returns {HttpResponse} */
function requestWebSession(user) {
  const response = http.post(
    `${baseUrl}/v1/auth/web-sessions/exchange`,
    JSON.stringify({ web_session_token: user.webSessionToken }),
    {
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        'X-AIHUB-Client-Secret': bffSecret,
      },
    },
  );
  recordResponse('web_session_exchange', response);
  return response;
}

/** @param {RouteName} name @param {HttpResponse} response */
function recordResponse(name, response) {
  routeResponseCounts[name].add(1);
  if (
    response.status === 0 ||
    response.error_code > 0 ||
    Boolean(response.error) ||
    response.status >= 400
  ) {
    routeErrorCounts[name].add(1);
  }
  // No HTTP status means the gateway never answered, so its log has no code.
  if (response.status === 0) routeTransportErrorCounts[name].add(1);
  apiLatency[name].add(response.timings.duration);
  if (response.status >= 200 && response.status < 300) {
    acceptedLatency[name].add(response.timings.duration);
    if (
      isGradingRouteName(name) &&
      response.timings.duration <= gradingRouteDeadlinesMs[name]
    ) {
      const elapsedSecond = Math.floor(
        (Date.now() - exec.scenario.startTime) / 1000,
      );
      if (elapsedSecond >= 0 && elapsedSecond < durationSeconds) {
        routeGoodputCounts[name].add(1);
        if (isRecovery) {
          goodputBySecond.add(1, {
            route: name,
            second: String(elapsedSecond),
          });
        }
      }
    }
  }
}

/** @param {'health' | 'readiness'} name @param {'/health' | '/ready'} path */
function recordProbe(name, path) {
  const response = http.get(`${baseUrl}${path}`, {
    timeout: '5s',
    headers: { Host: host },
    tags: { name: `probe_${name}` },
  });
  probeLatencies[name].add(response.timings.duration);
  if (response.status < 200 || response.status >= 300 || response.error) {
    probeFailures[name].add(1);
  }
}

/** @param {HttpResponse} response */
function captureRefreshToken(response) {
  const cookie =
    response.headers['Set-Cookie'] || response.headers['set-cookie'];
  const values = Array.isArray(cookie) ? cookie : [cookie];
  for (const value of values) {
    const match =
      value && value.match(new RegExp(`${refreshCookieName}=([^;]+)`));
    if (match && match[1] !== undefined) {
      refreshToken = decodeURIComponent(match[1]);
    }
  }
}

/** @param {string} body @returns {unknown} */
function parseJson(body) {
  try {
    return /** @type {unknown} */ (JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {{question: string, topic: string, essay: string, url: string}} */
function parseTask1Fixture(value) {
  if (
    !isRecord(value) ||
    typeof value.question !== 'string' ||
    typeof value.topic !== 'string' ||
    typeof value.essay !== 'string' ||
    typeof value.url !== 'string'
  ) {
    throw new Error('capacity benchmark task1 fixture is invalid');
  }
  return {
    question: value.question,
    topic: value.topic,
    essay: value.essay,
    url: value.url,
  };
}

/** @param {string} source @returns {Record<string, unknown>} */
function parseJsonObject(source) {
  const value = /** @type {unknown} */ (JSON.parse(source));
  if (!isRecord(value))
    throw new Error('capacity benchmark fixture is invalid');
  return value;
}

/** @param {unknown} value @returns {BenchmarkCredentials} */
function parseBenchmarkCredentials(value) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.users) ||
    value.users.length === 0 ||
    !Array.isArray(value.organizations) ||
    value.organizations.length === 0
  ) {
    throw new Error('benchmark credential seed is incomplete');
  }
  const users = value.users.map((user) => {
    if (
      !isRecord(user) ||
      typeof user.userId !== 'string' ||
      typeof user.email !== 'string' ||
      typeof user.password !== 'string' ||
      typeof user.refreshToken !== 'string' ||
      typeof user.webSessionToken !== 'string'
    ) {
      throw new Error('benchmark credential seed is incomplete');
    }
    return {
      userId: user.userId,
      email: user.email,
      password: user.password,
      refreshToken: user.refreshToken,
      webSessionToken: user.webSessionToken,
    };
  });
  const organizations = value.organizations.map((organization) => {
    if (!isRecord(organization) || typeof organization.apiKey !== 'string') {
      throw new Error('benchmark organization seed is incomplete');
    }
    return { apiKey: organization.apiKey };
  });
  return { users, organizations };
}
