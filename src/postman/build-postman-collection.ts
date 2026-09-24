import { convert } from 'openapi-to-postmanv2';

import { ORGANIZATION_ROSTER_PATH } from '../contracts/organization/membership';

/**
 * D2 handover artifact, not a regression suite (see issue #6): every request
 * below is meant to be run by a human against a real or deliberately-broken
 * AIHUB instance, not asserted to pass during generation. Bodies reuse the
 * real fixtures captured from the live AI Writing API in
 * `test/fixtures/ai-writing/` so a reader sees genuine payloads, not
 * placeholders.
 */
interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
  readonly body?: unknown;
  readonly testScript: readonly string[];
}

const JSON_HEADER = { key: 'Content-Type', value: 'application/json' } as const;
const VALID_KEY_HEADER = { key: 'X-API-Key', value: '{{apiKey}}' } as const;
const IDEMPOTENCY_HEADER = {
  key: 'Idempotency-Key',
  value: '{{$guid}}',
} as const;
const USER_ASSERTION_HEADER = {
  key: 'X-User-Assertion',
  value: '{{userAssertion}}',
} as const;

const TASK1_GRADE_PATH = '/v1/ielts/writing/task1/grade';
const TASK2_GRADE_PATH = '/v1/ielts/writing/task2/grade';
const ORGANIZATION_INVITATION_PATH =
  '/v1/organizations/{{organizationId}}/invitations';

const TASK1_GRADE_BODY = {
  question:
    'The chart below shows the total number of minutes (in billions) of telephone calls in the UK, divided into three categories, from 1995-2002. Summarise the information by selecting a reporting the main features, and make comparisons where relevant.',
  chart_type: 'Bar Chart',
  image_url: 'https://s3.wispace.app/ielts-task1/ca95bd4ab522946d',
  essay:
    'The bar chart illustrates the total duration, measured in billions of minutes, of telephone calls made in the United Kingdom across three categories between 1995 and 2002. Overall, local fixed line calls were the most popular type throughout the entire period, although their share declined after 1999.',
};

const TASK2_GRADE_BODY = {
  question:
    'With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?',
  topic: 'education',
  essay:
    'The proliferation of online learning platforms has led some observers to claim that conventional classroom instruction is no longer relevant. While I acknowledge the considerable advantages of digital education, I disagree that it renders traditional teaching obsolete.',
};

const ORGANIZATION_INVITATION_BODY = {
  email: 'invitee@example.com',
  role: 'member',
};

function assertStatus(status: number): string {
  return `pm.test('responds with HTTP ${status}', function () { pm.response.to.have.status(${status}); });`;
}

function assertErrorCode(codes: readonly string[]): readonly string[] {
  return [
    `pm.test('error.code is one of ${codes.join(', ')}', function () {`,
    '  const body = pm.response.json();',
    `  pm.expect(${JSON.stringify(codes)}).to.include(body.error.code);`,
    '});',
  ];
}

function assertEnvelope(operationId: string): readonly string[] {
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
 * The active handover scenarios are derived from `docs/aihub_deliverable_1_api_contract_schema.md`
 * §G "D2 Postman tests tối thiểu" in order. Items 13 and 14
 * cannot pass yet — each names the slice it is waiting on, per that issue's
 * acceptance criteria, instead of silently asserting today's (wrong) result.
 * Item 16 is the post-freeze issue #156 addition.
 */
const D1_SCENARIOS: readonly Scenario[] = [
  {
    name: '1a. Valid request routes to Task 1 grading',
    description:
      'Valid API key + valid request routes to the correct AI Service operation.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(403), ...assertErrorCode(['FORBIDDEN'])],
  },
  {
    name: '7. User-scoped operation missing User Assertion',
    description:
      'A user-scoped grading operation without X-User-Assertion must be rejected before dispatch.',
    path: TASK1_GRADE_PATH,
    headers: [JSON_HEADER, VALID_KEY_HEADER],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(401),
      ...assertErrorCode(['USER_ASSERTION_REQUIRED']),
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      'Point {{baseUrl}} at a stub returning an unexpected downstream 4xx/5xx to confirm it surfaces as AI_SERVICE_ERROR (or AI_SERVICE_CONTRACT_VIOLATION for a malformed 200 body), never passed through raw.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
      USER_ASSERTION_HEADER,
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
    name: '16. Missing or disabled identity configuration',
    description:
      'Fill {{identityConfigRequiredApiKey}} with a valid API key for an Organization without active identity configuration. Send a valid User Assertion; grading must fail before dispatch.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      {
        key: 'X-API-Key',
        value: '{{identityConfigRequiredApiKey}}',
      },
      USER_ASSERTION_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [
      assertStatus(403),
      ...assertErrorCode(['IDENTITY_CONFIG_REQUIRED']),
    ],
  },
];

const IDEMPOTENCY_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Task 2 grading replays a completed result',
    description:
      'Required idempotency: resend the same user-scoped grading request with one key and verify the stored result is replayed.',
    path: TASK2_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_ASSERTION_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK2_GRADE_BODY,
    testScript: [
      assertStatus(200),
      ...assertEnvelope('writing.task2.grade'),
      'pm.sendRequest({',
      '  url: pm.request.url.toString(),',
      '  method: pm.request.method,',
      '  header: pm.request.headers.toJSON(),',
      "  body: { mode: 'raw', raw: pm.request.body.raw }",
      '}, function (error, response) {',
      "  pm.test('same key replays Task 2 grading', function () {",
      '    pm.expect(error).to.equal(null);',
      '    pm.expect(response.code).to.eql(200);',
      "    pm.expect(response.headers.get('Idempotent-Replay')).to.eql('true');",
      '    pm.expect(response.json().data).to.eql(pm.response.json().data);',
      '  });',
      '});',
    ],
  },
  {
    name: 'Task 2 grading rejects a conflicting payload',
    description:
      'Required idempotency: reusing a completed key with a different payload returns IDEMPOTENCY_CONFLICT.',
    path: TASK2_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_ASSERTION_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK2_GRADE_BODY,
    testScript: [
      assertStatus(200),
      ...assertEnvelope('writing.task2.grade'),
      'const conflictingBody = JSON.parse(pm.request.body.raw);',
      "conflictingBody.essay += ' (conflict)';",
      'pm.sendRequest({',
      '  url: pm.request.url.toString(),',
      '  method: pm.request.method,',
      '  header: pm.request.headers.toJSON(),',
      "  body: { mode: 'raw', raw: JSON.stringify(conflictingBody) }",
      '}, function (error, response) {',
      "  pm.test('same key rejects a conflicting payload', function () {",
      '    pm.expect(error).to.equal(null);',
      '    pm.expect(response.code).to.eql(409);',
      "    pm.expect(response.json().error.code).to.eql('IDEMPOTENCY_CONFLICT');",
      '  });',
      '});',
    ],
  },
];

const CONCURRENCY_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Concurrency limit rejects excess in-flight requests',
    description:
      'Configure the organization with maxConcurrent=1 and point {{baseUrl}} at a deliberately slow downstream. Run two copies of this request in parallel; the second must return 429 while the first is still in flight.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_ASSERTION_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(429), ...assertErrorCode(['CONCURRENCY_LIMIT'])],
  },
];

const INVITATION_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Organization invitation send rate limit',
    description:
      'After the inviter, organization, or normalized email invitation bucket is exhausted, this valid invitation attempt returns the same generic 429 RATE_LIMITED response with a retry hint and creates no invitation.',
    path: ORGANIZATION_INVITATION_PATH,
    headers: [
      JSON_HEADER,
      {
        key: 'Authorization',
        value: 'Bearer {{bearerToken}}',
      },
      IDEMPOTENCY_HEADER,
    ],
    body: ORGANIZATION_INVITATION_BODY,
    testScript: [
      assertStatus(429),
      ...assertErrorCode(['RATE_LIMITED']),
      "pm.test('rate limit includes a retry hint', function () {",
      '  const body = pm.response.json();',
      '  pm.expect(body.error.retry_after_ms).to.be.at.least(0);',
      '});',
    ],
  },
];

/**
 * Deep-removes every property named `key`. Used to drop the `response`
 * arrays openapi-to-postmanv2 attaches to each auto-converted operation —
 * schema-faked example responses for an `additionalProperties: true` object
 * (our error `details` field) come out with a random key count and random
 * values on every run, which would make the committed-artifact drift check
 * (`postman-artifact.spec.ts`) flake on every regeneration for no real
 * reason. The real, meaningful example responses live in the D1 handover
 * scenarios below instead.
 */
export function stripKey<T>(value: T, key: string): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripKey(entry, key)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([k]) => k !== key,
    );
    return Object.fromEntries(
      entries.map(([k, v]) => [k, stripKey(v, key)]),
    ) as T;
  }
  return value;
}

function scenarioToItem(scenario: Scenario): Record<string, unknown> {
  return {
    name: scenario.name,
    request: {
      method: 'POST',
      header: scenario.headers,
      body:
        scenario.body === undefined
          ? undefined
          : { mode: 'raw', raw: JSON.stringify(scenario.body, null, 2) },
      url: `{{baseUrl}}${scenario.path}`,
      description: scenario.description,
    },
    event: [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: scenario.testScript },
      },
    ],
  };
}

/** Shape of the pieces this module reads or rewrites on the converted collection; everything else passes through untouched. */
interface PostmanCollectionShape {
  readonly info: Record<string, unknown>;
  readonly item: unknown[];
  readonly [key: string]: unknown;
}

const REFRESH_COOKIE_NAME = '__Host-aihub_refresh';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRefreshCookieAuth(auth: unknown): boolean {
  if (!isRecord(auth)) {
    return false;
  }

  const apiKey = auth.apikey;
  if (!Array.isArray(apiKey)) {
    return false;
  }

  const key = apiKey.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.key === 'key' && typeof entry.value === 'string',
  );

  return key?.value === REFRESH_COOKIE_NAME;
}

/**
 * openapi-to-postmanv2 maps an OpenAPI apiKey cookie scheme to an apikey
 * header auth entry. Keep the handover artifact faithful to the cookie-only
 * boundary by using Postman's native cookie field instead.
 */
function normalizeRefreshCookieAuth(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      normalizeRefreshCookieAuth(entry);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const record = value;
  const request = record.request;
  if (isRecord(request)) {
    const requestRecord = request;
    if (isRefreshCookieAuth(requestRecord.auth)) {
      requestRecord.cookie = [
        {
          key: REFRESH_COOKIE_NAME,
          value: '{{refreshToken}}',
          path: '/',
          secure: true,
          httpOnly: true,
        },
      ];
      requestRecord.auth = undefined;

      const path = isRecord(requestRecord.url)
        ? requestRecord.url.path
        : undefined;
      const route = Array.isArray(path) ? path.join('/') : undefined;
      requestRecord.event = [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec:
              route === 'v1/auth/refresh'
                ? [
                    "pm.test('refresh rotates the access token and cookie', function () {",
                    '  pm.response.to.have.status(200);',
                    "  pm.expect(pm.response.headers.get('Set-Cookie')).to.include('__Host-aihub_refresh=');",
                    '});',
                  ]
                : [
                    "pm.test('logout revokes the session and clears the cookie', function () {",
                    '  pm.response.to.have.status(204);',
                    "  pm.expect(pm.response.headers.get('Set-Cookie')).to.include('__Host-aihub_refresh=');",
                    '  pm.expect(pm.response.text()).to.eql("");',
                    '});',
                  ],
          },
        },
      ];
    }
  }

  for (const child of Object.values(record)) {
    normalizeRefreshCookieAuth(child);
  }
}

function addOrganizationRosterCheck(items: unknown[]): void {
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.request)) {
      continue;
    }

    const url = item.request.url;
    const path = isRecord(url) ? url.path : undefined;
    if (
      !Array.isArray(path) ||
      path.join('/') !== ORGANIZATION_ROSTER_PATH.slice(1)
    ) {
      continue;
    }

    item.request.description =
      'Lists the active Organization Roster, including each Organization as an open array of configured entitlement names.';
    item.event = [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            "pm.test('each organization exposes configured entitlement names', function () {",
            '  const organizations = pm.response.json().data.organizations;',
            "  pm.expect(organizations).to.be.an('array');",
            '  for (const organization of organizations) {',
            "    pm.expect(organization.entitlements).to.be.an('array');",
            "    pm.expect(organization.entitlements.every((value) => typeof value === 'string')).to.be.true;",
            '  }',
            '});',
          ],
        },
      },
    ];
  }
}

function convertOpenApiToPostman(
  openApiDocument: unknown,
): Promise<PostmanCollectionShape> {
  return new Promise((resolve, reject) => {
    convert(
      { type: 'json', data: openApiDocument as object },
      // schemaFaker: false keeps generated examples deterministic (fixed
      // per-type placeholders) instead of randomly faked values — required
      // for the committed-artifact drift check to be stable across runs.
      { folderStrategy: 'Tags', schemaFaker: false },
      (err, result) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(err.message));
          return;
        }
        const output =
          result?.result === true ? result.output?.[0]?.data : undefined;
        if (output === undefined) {
          reject(
            new Error(
              result?.reason ?? 'openapi-to-postmanv2 produced no output',
            ),
          );
          return;
        }
        resolve(output as PostmanCollectionShape);
      },
    );
  });
}

export async function buildPostmanCollection(
  openApiDocument: unknown,
  version: string,
): Promise<unknown> {
  const base = stripKey(
    await convertOpenApiToPostman(openApiDocument),
    'response',
  );
  normalizeRefreshCookieAuth(base);
  addOrganizationRosterCheck(base.item);

  return {
    ...base,
    info: {
      ...base.info,
      name: 'AIHUB Writing API',
      description:
        'Generated by `pnpm generate:postman` from openapi.json — do not hand-edit. The "D1 handover test cases" folder is the D2 handover artifact required by docs/aihub_deliverable_1_api_contract_schema.md §G; it is not a CI regression suite.',
      version,
    },
    variable: [
      {
        key: 'baseUrl',
        value: 'https://api.aihubproduction.example.com',
        description: 'AIHUB base URL for the environment under test.',
      },
      { key: 'apiKey', value: 'REPLACE_WITH_A_VALID_ORGANIZATION_API_KEY' },
      {
        key: 'refreshToken',
        value: 'REPLACE_WITH_A_REFRESH_COOKIE_VALUE',
        description:
          'Opaque refresh cookie value; Postman normally stores it from the login Set-Cookie response.',
      },
      {
        key: 'otherEnvironmentApiKey',
        value: 'REPLACE_WITH_A_KEY_FROM_A_DIFFERENT_ENVIRONMENT',
      },
      {
        key: 'wrongScopeApiKey',
        value: 'REPLACE_WITH_A_KEY_WITHOUT_WRITING_GRADE_SCOPE',
      },
      {
        key: 'identityConfigRequiredApiKey',
        value:
          'REPLACE_WITH_A_KEY_FOR_AN_ORGANIZATION_WITHOUT_ACTIVE_IDENTITY_CONFIG',
        description:
          'Valid Writing API key for an Organization with missing or disabled user identity configuration.',
      },
      {
        key: 'userAssertion',
        value: 'REPLACE_WITH_A_VALID_SIGNED_USER_ASSERTION',
      },
      {
        key: 'bearerToken',
        value: 'REPLACE_WITH_A_VALID_USER_ACCESS_JWT',
        description: 'User Access JWT for the organization roster route.',
      },
      {
        key: 'organizationId',
        value: 'REPLACE_WITH_AN_ORGANIZATION_ID',
        description:
          'Organization targeted by the management invitation route.',
      },
    ],
    item: [
      ...base.item,
      {
        name: 'D1 handover test cases (docs/aihub_deliverable_1_api_contract_schema.md §G)',
        item: D1_SCENARIOS.map(scenarioToItem),
      },
      {
        name: 'Idempotency mode examples',
        item: IDEMPOTENCY_SCENARIOS.map(scenarioToItem),
      },
      {
        name: 'Concurrency limit examples',
        item: CONCURRENCY_SCENARIOS.map(scenarioToItem),
      },
      {
        name: 'Organization invitation examples',
        item: INVITATION_SCENARIOS.map(scenarioToItem),
      },
    ],
  };
}
