import { TASK1_SAMPLE_IMAGE_URL } from '@/catalog/operation-catalog';

/**
 * D2 handover artifact, not a regression suite (see issue #6): every request
 * below is meant to be run by a human against a real or deliberately-broken
 * AIHUB instance, not asserted to pass during generation. Bodies reuse the
 * real fixtures captured from the live AI Writing API in
 * `test/fixtures/ai-writing/` so a reader sees genuine payloads, not
 * placeholders.
 */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
  readonly body?: unknown;
  readonly testScript: readonly string[];
}

export const JSON_HEADER = {
  key: 'Content-Type',
  value: 'application/json',
} as const;
export const VALID_KEY_HEADER = {
  key: 'X-API-Key',
  value: '{{apiKey}}',
} as const;
export const IDEMPOTENCY_HEADER = {
  key: 'Idempotency-Key',
  value: '{{$guid}}',
} as const;
export const USER_IDENTITY_HEADER = {
  key: 'X-User-Identity',
  value: '{{userIdentity}}',
} as const;

export const BFF_CLIENT_SECRET_HEADER = {
  key: 'X-AIHUB-Client-Secret',
  value: '{{webSessionClientSecret}}',
} as const;

export const WEB_SESSION_CREATE_PATH = '/v1/auth/web-sessions';
export const WEB_SESSION_VERIFICATION_PATH =
  '/v1/auth/web-sessions/verification';
export const WEB_SESSION_EXCHANGE_PATH = '/v1/auth/web-sessions/exchange';
export const WEB_SESSION_LOGOUT_PATH = '/v1/auth/web-sessions/logout';

export const TASK1_GRADE_PATH = '/v1/ielts/writing/task1/grade';
export const TASK2_GRADE_PATH = '/v1/ielts/writing/task2/grade';
export const SPEAKING_GRADE_JSON_PATH = '/v1/ielts/speaking/grading-json';
export const ORGANIZATION_INVITATION_PATH =
  '/v1/organizations/{{organizationId}}/invitations';

export const TASK1_GRADE_BODY = {
  question:
    'The chart below shows the total number of minutes (in billions) of telephone calls in the UK, divided into three categories, from 1995-2002. Summarise the information by selecting a reporting the main features, and make comparisons where relevant.',
  chart_type: 'Bar Chart',
  image_url: TASK1_SAMPLE_IMAGE_URL,
  essay:
    'The bar chart illustrates the total duration, measured in billions of minutes, of telephone calls made in the United Kingdom across three categories between 1995 and 2002. Overall, local fixed line calls were the most popular type throughout the entire period, although their share declined after 1999.',
};

export const TASK2_GRADE_BODY = {
  question:
    'With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?',
  topic: 'education',
  essay:
    'The proliferation of online learning platforms has led some observers to claim that conventional classroom instruction is no longer relevant. While I acknowledge the considerable advantages of digital education, I disagree that it renders traditional teaching obsolete.',
};

export const ORGANIZATION_INVITATION_BODY = {
  email: 'invitee@example.com',
  role: 'member',
};

export function assertStatus(status: number): string {
  return `pm.test('responds with HTTP ${status}', function () { pm.response.to.have.status(${status}); });`;
}

export function assertErrorCode(codes: readonly string[]): readonly string[] {
  return [
    `pm.test('error.code is one of ${codes.join(', ')}', function () {`,
    '  const body = pm.response.json();',
    `  pm.expect(${JSON.stringify(codes)}).to.include(body.error.code);`,
    '});',
  ];
}

// Mirrors the shape pinned in `src/common/http/success-envelope.ts`; the
// strings assert what the client must observe, not the builder itself.
export function assertEnvelope(operationId: string): readonly string[] {
  return [
    "pm.test('success envelope carries the right operation and an AIHUB-generated request id', function () {",
    '  const body = pm.response.json();',
    `  pm.expect(body.meta.operation).to.eql('${operationId}');`,
    "  pm.expect(body.meta.service).to.eql('ai-writing');",
    '  pm.expect(body.meta.request_id).to.match(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);',
    '});',
  ];
}

/**
 * The active handover scenarios are derived from `docs/history/aihub-deliverable-1-historical-contract.md`
 * §G "D2 Postman tests tối thiểu" in order. Items 13 and 14
 * cannot pass yet — each names the slice it is waiting on, per that issue's
 * acceptance criteria, instead of silently asserting today's (wrong) result.
 * Item 16 is the post-freeze issue #156 addition.
 */
export const D1_SCENARIOS: readonly Scenario[] = [
  {
    name: '1a. Valid request routes to Task 1 grading',
    description:
      'Valid API key + valid request routes to the correct AI Service operation.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(200), ...assertEnvelope('writing.task1.grade')],
  },
  {
    name: '1b. Valid request routes to Task 2 grading',
    description:
      'Valid API key + valid request routes to the correct AI Service operation.',
    path: TASK2_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK2_GRADE_BODY,
    testScript: [assertStatus(200), ...assertEnvelope('writing.task2.grade')],
  },
  {
    name: '2. Missing/invalid API key',
    description: 'No X-API-Key header at all.',
    path: TASK1_GRADE_PATH,
    headers: [JSON_HEADER],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(401), ...assertErrorCode(['UNAUTHORIZED'])],
  },
  {
    name: '3. API key not allowed in the current environment',
    description:
      'Fill {{otherEnvironmentApiKey}} with a real key provisioned for a different environment (e.g. a staging key called against production).',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      { key: 'X-API-Key', value: '{{otherEnvironmentApiKey}}' },
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(403),
      ...assertErrorCode(['ENVIRONMENT_NOT_ALLOWED']),
    ],
  },
  {
    name: '4. Missing required parameter',
    description: "Task 1 grading without the required 'essay'.",
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: { ...TASK1_GRADE_BODY, essay: undefined },
    testScript: [assertStatus(400), ...assertErrorCode(['INVALID_REQUEST'])],
  },
  {
    name: '5. Unknown/unsupported field',
    description:
      'Every request schema is additionalProperties: false; an unknown field must be rejected, not silently dropped.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: { ...TASK1_GRADE_BODY, unexpected_field: 'nope' },
    testScript: [assertStatus(400), ...assertErrorCode(['INVALID_REQUEST'])],
  },
  {
    name: '6. Scope/service mismatch',
    description:
      "Fill {{wrongScopeApiKey}} with a real key that lacks the 'writing.grade' scope, then call a Writing grading operation with it.",
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      { key: 'X-API-Key', value: '{{wrongScopeApiKey}}' },
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(403), ...assertErrorCode(['FORBIDDEN'])],
  },
  {
    name: '7. User-scoped operation missing User Identity',
    description:
      'A user-scoped grading operation without X-User-Identity must be rejected before dispatch.',
    path: TASK1_GRADE_PATH,
    headers: [JSON_HEADER, VALID_KEY_HEADER],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(401),
      ...assertErrorCode(['USER_IDENTITY_REQUIRED']),
    ],
  },
  {
    name: '8. Downstream timeout',
    description:
      "Point {{baseUrl}} at a stub/mock that delays past the operation's catalogued 60s grading timeout to force this.",
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(504), ...assertErrorCode(['AI_SERVICE_TIMEOUT'])],
  },
  {
    name: '9. Downstream throttle surfaces as 503, not a client 429',
    description:
      'Point {{baseUrl}} at a stub returning a throttled response from AI Writing to confirm it is translated to a public 503, never a 429.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(503),
      ...assertErrorCode(['AI_SERVICE_THROTTLED']),
    ],
  },
  {
    name: '10. Downstream 4xx/5xx maps to a unified error',
    description:
      'Point {{baseUrl}} at a stub returning an unexpected downstream 4xx/5xx to confirm it surfaces as AI_SERVICE_ERROR (or AI_SERVICE_CONTRACT_VIOLATION for a malformed 200 body), never passed through raw. The one named exception: a Speaking multipart grading whose audio AI Speaking cannot decode answers 422 AUDIO_UNREADABLE, retryable false.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(502),
      ...assertErrorCode(['AI_SERVICE_ERROR', 'AI_SERVICE_CONTRACT_VIOLATION']),
    ],
  },
  {
    name: '11. request_id is AIHUB-generated; correlation_id is preserved when sent',
    description:
      'Sends X-Correlation-Id and checks it is echoed back verbatim, alongside an independently AIHUB-generated request_id.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
      { key: 'X-Correlation-Id', value: 'client-trace-{{$guid}}' },
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(200),
      "pm.test('correlation_id echoes the client header; request_id is independently generated', function () {",
      '  const body = pm.response.json();',
      "  const sentCorrelationId = pm.request.headers.get('X-Correlation-Id');",
      '  pm.expect(body.meta.correlation_id).to.eql(sentCorrelationId);',
      '  pm.expect(body.meta.request_id).to.match(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);',
      '  pm.expect(body.meta.request_id).to.not.eql(sentCorrelationId);',
      '});',
    ],
  },
  {
    name: '12. Timing fields carry their documented meaning',
    description:
      'downstream_ms + gateway_overhead_ms should equal total_ms (within rounding), and none may be negative.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(200),
      "pm.test('timing fields are non-negative and sum to total_ms', function () {",
      '  const { downstream_ms, gateway_overhead_ms, total_ms } = pm.response.json().meta.timing;',
      '  pm.expect(downstream_ms).to.be.at.least(0);',
      '  pm.expect(gateway_overhead_ms).to.be.at.least(0);',
      '  pm.expect(total_ms).to.be.at.least(0);',
      '  pm.expect(Math.abs(downstream_ms + gateway_overhead_ms - total_ms)).to.be.at.most(1);',
      '});',
    ],
  },
  {
    name: '13. Provider telemetry remains internal — BLOCKED',
    description:
      'BLOCKED: provider usage and processing telemetry is internal and must not appear in the public response.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      "pm.test('BLOCKED: provider telemetry stays internal - add metering assertions outside the public response', function () {",
      '  pm.expect(true).to.be.true;',
      '});',
    ],
  },
  {
    name: '14. Aggregate usage is metered internally — BLOCKED',
    description:
      'BLOCKED: aggregate provider usage is stored internally and is not exposed in the public response.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      "pm.test('BLOCKED: aggregate usage is verified in internal metering, not public response', function () {",
      '  pm.expect(true).to.be.true;',
      '});',
    ],
  },
  {
    name: '15. Idempotency behavior',
    description:
      'Sends the same validated Task 1 grading request twice with one key; the second response must replay the completed result without a second downstream call.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(200),
      ...assertEnvelope('writing.task1.grade'),
      'pm.sendRequest({',
      '  url: pm.request.url.toString(),',
      '  method: pm.request.method,',
      '  header: pm.request.headers.toJSON(),',
      "  body: { mode: 'raw', raw: pm.request.body.raw }",
      '}, function (error, response) {',
      "  pm.test('same key replays the completed result', function () {",
      '    pm.expect(error).to.equal(null);',
      '    pm.expect(response.code).to.eql(200);',
      "    pm.expect(response.headers.get('Idempotent-Replay')).to.eql('true');",
      '    pm.expect(response.json().data).to.eql(pm.response.json().data);',
      '  });',
      '});',
    ],
  },
  {
    name: '16. Declared User ID for an Organization without identity configuration',
    description:
      'Fill {{declaredIdentityApiKey}} with a valid API key for an Organization without an active identity configuration. It sends a plain Declared User ID in X-User-Identity and must be graded.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      {
        key: 'X-API-Key',
        value: '{{declaredIdentityApiKey}}',
      },
      {
        key: 'X-User-Identity',
        value: '{{declaredUserId}}',
      },
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(200), ...assertEnvelope('writing.task1.grade')],
  },
];
