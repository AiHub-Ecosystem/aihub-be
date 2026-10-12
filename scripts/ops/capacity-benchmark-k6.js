import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';

const allRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
  'login',
  'refresh',
  'web_session_exchange',
];
const gradingRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];
const routeResponseCounts = {};
const routeErrorCounts = {};
for (const name of allRoutes) {
  routeResponseCounts[name] = new Counter(`benchmark_api_responses_${name}`);
  routeErrorCounts[name] = new Counter(`benchmark_api_errors_${name}`);
}
function trends(names, prefix, isTime) {
  const result = {};
  for (const name of names) {
    result[name] = new Trend(`${prefix}${name}`, isTime);
  }
  return result;
}
const apiLatency = trends(allRoutes, 'benchmark_latency_', true);
const gatewayTotal = trends(gradingRoutes, 'benchmark_gateway_total_', true);
const downstream = trends(gradingRoutes, 'benchmark_downstream_', true);
const processRss = new Gauge('benchmark_process_rss_bytes');
const processHeap = new Gauge('benchmark_process_heap_bytes');
const eventLoopLag = new Gauge('benchmark_event_loop_lag_seconds');
const postgresWaiting = new Gauge('benchmark_postgres_waiting');
const downstreamQueued = new Gauge('benchmark_downstream_queued');

const task1 = JSON.parse(open('/fixtures/ai-writing/grade-task1.request.json'));
const task2 = JSON.parse(open('/fixtures/ai-writing/grade-task2.request.json'));
const credentials = JSON.parse(open('/data/credentials.json'));
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

const workload = __ENV.WORKLOAD || 'mixed_grading';
const rate = Number(__ENV.RATE || 4);
const duration = __ENV.DURATION || '15s';
const maxVUs = Number(__ENV.MAX_VUS || 256);

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
      gracefulStop: '5s',
      exec: 'load',
    },
    metrics: {
      executor: 'constant-arrival-rate',
      startTime: '0s',
      rate: 1,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 1,
      maxVUs: 1,
      gracefulStop: '5s',
      exec: 'scrapeMetrics',
    },
  },
  thresholds: {},
};

const grading = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];
const mixedWorkload = [
  'writing_task1',
  'writing_task1',
  'writing_task1',
  'writing_task2',
  'writing_task2',
  'writing_task2',
  'speaking_multipart',
  'speaking_multipart',
  'speaking_multipart',
  'speaking_json',
  'speaking_json',
  'speaking_json',
  'login',
  'login',
  'refresh',
  'web_session_exchange',
];

export function setup() {
  const reset = http.post(`${stubUrl}/__stats/reset`, null, {
    timeout: '5s',
  });
  if (reset.status !== 204) throw new Error('could not reset benchmark stub');
  return credentials;
}

let refreshToken;

export function load(data) {
  const index = (exec.vu.idInTest - 1) % data.users.length;
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
      mixedWorkload[exec.scenario.iterationInTest % mixedWorkload.length];
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

export function teardown() {
  const stats = http.get(`${stubUrl}/__stats`, { timeout: '5s' });
  if (stats.status === 200) {
    console.log(`BENCHMARK_STUB_STATS ${stats.body}`);
  }
}

export function handleSummary(data) {
  const summary = { state: data.state, metrics: data.metrics };
  return {
    stdout: `BENCHMARK_SUMMARY_JSON ${JSON.stringify(summary)}\n`,
  };
}

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
    const timing = payload && payload.meta && payload.meta.timing;
    if (timing && Number.isFinite(timing.total_ms)) {
      gatewayTotal[name].add(timing.total_ms);
    }
    if (timing && Number.isFinite(timing.downstream_ms)) {
      downstream[name].add(timing.downstream_ms);
    }
  }
  return response;
}

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
  apiLatency[name].add(response.timings.duration);
}

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

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
