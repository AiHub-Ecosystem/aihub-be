import { SPEAKING_SAMPLE_ANSWER } from '@/modules/speaking/application/speaking-question-catalog';
import type { Scenario } from './postman-scenarios';
import {
  BFF_CLIENT_SECRET_HEADER,
  IDEMPOTENCY_HEADER,
  JSON_HEADER,
  ORGANIZATION_INVITATION_BODY,
  ORGANIZATION_INVITATION_PATH,
  SPEAKING_GRADE_JSON_PATH,
  TASK1_GRADE_BODY,
  TASK1_GRADE_PATH,
  TASK2_GRADE_BODY,
  TASK2_GRADE_PATH,
  USER_IDENTITY_HEADER,
  VALID_KEY_HEADER,
  WEB_SESSION_CREATE_PATH,
  WEB_SESSION_EXCHANGE_PATH,
  WEB_SESSION_LOGOUT_PATH,
  WEB_SESSION_VERIFICATION_PATH,
  assertEnvelope,
  assertErrorCode,
  assertStatus,
} from './postman-scenarios';

const SPEAKING_SAMPLE_ANSWER_BODY = {
  audio_url: SPEAKING_SAMPLE_ANSWER.audioUrl,
  part: SPEAKING_SAMPLE_ANSWER.part,
  question_id: SPEAKING_SAMPLE_ANSWER.questionId,
  prompt_text: SPEAKING_SAMPLE_ANSWER.promptText,
  test_type: 'Practice',
};

export const IDEMPOTENCY_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Task 2 grading replays a completed result',
    description:
      'Required idempotency: resend the same user-scoped grading request with one key and verify the stored result is replayed.',
    path: TASK2_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
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
      USER_IDENTITY_HEADER,
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

export const CONCURRENCY_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Concurrency limit rejects excess in-flight requests',
    description:
      'Configure the organization with maxConcurrent=1 and point {{baseUrl}} at a deliberately slow downstream. Run two copies of this request in parallel; the second must return 429 while the first is still in flight.',
    path: TASK1_GRADE_PATH,
    headers: [
      JSON_HEADER,
      VALID_KEY_HEADER,
      USER_IDENTITY_HEADER,
      IDEMPOTENCY_HEADER,
    ],
    body: TASK1_GRADE_BODY,
    testScript: [assertStatus(429), ...assertErrorCode(['CONCURRENCY_LIMIT'])],
  },
];

export const INVITATION_SCENARIOS: readonly Scenario[] = [
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

export const SPEAKING_SAMPLE_ANSWER_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Grade the published Speaking sample answer',
    description:
      'Grades the public Part 1 candidate-answer recording with its matching question metadata. The audio URL is stable, unsigned, and publicly readable.',
    path: SPEAKING_GRADE_JSON_PATH,
    headers: [JSON_HEADER, VALID_KEY_HEADER, USER_IDENTITY_HEADER],
    body: SPEAKING_SAMPLE_ANSWER_BODY,
    testScript: [
      assertStatus(200),
      "pm.test('success envelope identifies the Speaking JSON operation and question', function () {",
      '  const body = pm.response.json();',
      "  pm.expect(body.meta.operation).to.eql('speaking.grading-json');",
      "  pm.expect(body.meta.service).to.eql('speaking');",
      `  pm.expect(body.data.question_id).to.eql('${SPEAKING_SAMPLE_ANSWER.questionId}');`,
      '});',
    ],
  },
];

/**
 * The four server-to-server Web Session routes, for the Customer Web BFF only.
 * These are not an integrator surface: the browser never holds the credential,
 * and every call needs the BFF's own static client secret in its own header.
 * The secret is a fake placeholder like every other credential here, so nothing
 * real can be committed and the folder is safe to open.
 */
export const WEB_SESSION_SCENARIOS: readonly Scenario[] = [
  {
    name: 'Create a Web Session from a password login',
    description:
      'Server-to-server only, Customer Web BFF. Signs a user in and answers an opaque Web Session token plus its expiry in the body. AIHUB sets no cookie: the BFF puts the token in its own HttpOnly cookie and keeps nothing else. The session lasts 30 days and renews as it is used.',
    path: WEB_SESSION_CREATE_PATH,
    headers: [JSON_HEADER, BFF_CLIENT_SECRET_HEADER],
    body: {
      email: 'REPLACE_WITH_A_REGISTERED_EMAIL',
      password: 'REPLACE_WITH_THE_PASSWORD',
    },
    testScript: [
      assertStatus(201),
      "pm.test('answers the web session token and its expiry in the body', function () {",
      '  const body = pm.response.json();',
      "  pm.expect(body.data.web_session_token).to.be.a('string');",
      "  pm.expect(body.data.expires_at).to.be.a('string');",
      '});',
      "pm.test('sets no cookie', function () {",
      "  pm.expect(pm.response.headers.get('Set-Cookie')).to.be.undefined;",
      '});',
      'pm.environment.set("webSessionToken", pm.response.json().data.web_session_token);',
    ],
  },
  {
    name: 'Create a Web Session from a Verification Sign-in',
    description:
      'Server-to-server only, Customer Web BFF. A verification token plus the Signup Browser Binding the Customer Web received, so the user is signed in right after verifying without typing a password again. A 204 means the email was verified but no browser matched the binding, which is the same answer the browser-facing verify route gives.',
    path: WEB_SESSION_VERIFICATION_PATH,
    headers: [JSON_HEADER, BFF_CLIENT_SECRET_HEADER],
    body: {
      token: 'REPLACE_WITH_A_VERIFICATION_TOKEN',
      browser_binding: 'REPLACE_WITH_A_SIGNUP_BROWSER_BINDING',
    },
    testScript: [
      "pm.test('verification answers 201 or 204', function () {",
      '  pm.expect(pm.response.code).to.be.oneOf([201, 204]);',
      '});',
      "pm.test('a 201 answers a session and a 204 signs nobody in', function () {",
      '  if (pm.response.code === 201) {',
      '    const body = pm.response.json();',
      "    pm.expect(body.data.web_session_token).to.be.a('string');",
      "    pm.expect(body.data.expires_at).to.be.a('string');",
      '  } else if (pm.response.code === 204) {',
      "    pm.expect(pm.response.text()).to.eql('');",
      '  }',
      '});',
    ],
  },
  {
    name: 'Exchange a Web Session for a User Access JWT',
    description:
      'Server-to-server only, Customer Web BFF. Every call signs a fresh 15-minute JWT, so a multi-instance BFF needs no shared store and no lock. A successful exchange slides the session 30 days forward, writing at most once an hour. AIHUB stores no JWT, so the BFF may cache one in process until shortly before it expires and a JWT signed before a logout can stay valid for up to 15 minutes. Any bad session answers one generic 401; an infrastructure failure answers 503 with no credential, so keep the cookie and retry.',
    path: WEB_SESSION_EXCHANGE_PATH,
    headers: [JSON_HEADER, BFF_CLIENT_SECRET_HEADER],
    body: { web_session_token: '{{webSessionToken}}' },
    testScript: [
      assertStatus(200),
      "pm.test('answers the same envelope as login', function () {",
      '  const body = pm.response.json();',
      "  pm.expect(body.data.access_token).to.be.a('string');",
      "  pm.expect(body.data.token_type).to.eql('Bearer');",
      '  pm.expect(body.data.expires_in).to.eql(900);',
      '});',
      'pm.environment.set("bearerToken", pm.response.json().data.access_token);',
    ],
  },
  {
    name: 'Logout a Web Session',
    description:
      'Server-to-server only, Customer Web BFF. Revokes only the presented session and answers 204. Logging out twice, or from a stale tab, answers 204 as well. Other devices stay signed in; a password reset is what ends every session of the account.',
    path: WEB_SESSION_LOGOUT_PATH,
    headers: [JSON_HEADER, BFF_CLIENT_SECRET_HEADER],
    body: { web_session_token: '{{webSessionToken}}' },
    testScript: [assertStatus(204)],
  },
];
