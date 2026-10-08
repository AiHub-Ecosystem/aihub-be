import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MockAgent } from 'undici';

import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import {
  type CanaryResult,
  type WebhookPayload,
  exitCodeForResult,
  runCanary,
} from './canary-ai-writing';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): object {
  return JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', 'test', 'fixtures', 'ai-writing', name),
      'utf8',
    ),
  ) as object;
}

const G1_RESPONSE = loadFixture('grade-task1.response.json');
const G2_RESPONSE = loadFixture('grade-task2.response.json');

const BASE_URL = 'https://ai-writing.test';
const AUTH = 'Bearer test-token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

function registerAll(agent: MockAgent): void {
  agent
    .get(BASE_URL)
    .intercept({ method: 'POST', path: '/grading-feedback-task1' })
    .reply(200, G1_RESPONSE);
  agent
    .get(BASE_URL)
    .intercept({ method: 'POST', path: '/grading-feedback-task2' })
    .reply(200, G2_RESPONSE);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCanary', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = buildMockAgent();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  // -------------------------------------------------------------------------
  // Test 1: Both grading probes pass — outcome ok, exit 0, webhook sink not called
  // -------------------------------------------------------------------------
  it('returns outcome ok and exit code 0 when both fixture responses are valid', async () => {
    registerAll(mockAgent);

    const httpClient = new DownstreamHttpClient(BASE_URL, mockAgent);
    const webhookSink = jest.fn<Promise<void>, [WebhookPayload]>();

    const result = await runCanary({
      httpClient,
      authorization: AUTH,
      webhookSink,
    });

    expect(result.outcome).toBe('ok');
    expect(result.failures).toHaveLength(0);
    expect(result.successes).toHaveLength(2);

    const ops = result.successes.map((s) => s.operation);
    expect(ops).toContain('writing.task1.grade');
    expect(ops).toContain('writing.task2.grade');

    // Webhook is never called on success.
    expect(webhookSink).not.toHaveBeenCalled();

    expect(exitCodeForResult(result, false)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: One response mutated to break its shape → drift, webhook called
  // -------------------------------------------------------------------------
  it('detects drift when task1 grade response is missing required fields', async () => {
    // essay content from the grade fixture — must NOT appear anywhere in the
    // serialized webhook payload (redaction check from issue #17).
    const essayMarker =
      'The bar chart illustrates the total duration, measured in billions of minutes';

    // Deliberately broken: strip `data.overall_band` so parseGradeResponse throws.
    mockAgent
      .get(BASE_URL)
      .intercept({ method: 'POST', path: '/grading-feedback-task1' })
      .reply(200, { success: true, data: { evaluation: {} } });
    mockAgent
      .get(BASE_URL)
      .intercept({ method: 'POST', path: '/grading-feedback-task2' })
      .reply(200, G2_RESPONSE);

    const capturedPayloads: WebhookPayload[] = [];
    const webhookSink = jest
      .fn<Promise<void>, [WebhookPayload]>()
      .mockImplementation(async (p) => {
        capturedPayloads.push(p);
      });

    const httpClient = new DownstreamHttpClient(BASE_URL, mockAgent);
    const result = await runCanary({
      httpClient,
      authorization: AUTH,
      webhookSink,
    });

    expect(result.outcome).toBe('drift');

    const driftFailure = result.failures.find(
      (f) => f.operation === 'writing.task1.grade',
    );
    expect(driftFailure).toBeDefined();
    expect(driftFailure?.class).toBe('AI_SERVICE_CONTRACT_VIOLATION');

    // Webhook called exactly once.
    expect(webhookSink).toHaveBeenCalledTimes(1);

    // Serialized payload must not contain cause.message text or essay text.
    const serialized = JSON.stringify(capturedPayloads[0]);
    expect(serialized).not.toContain('missing numeric data.overall_band');
    expect(serialized).not.toContain(essayMarker);
    // detail is AppError.code only, no raw downstream content.
    expect(capturedPayloads[0]?.failures[0]?.detail).toMatch(
      /^AI_SERVICE_CONTRACT_VIOLATION/,
    );

    expect(exitCodeForResult(result, false)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: MockAgent replies 503 for one endpoint → unverified, class http_5xx
  // -------------------------------------------------------------------------
  it('classifies a 503 response as unverified with class http_5xx', async () => {
    // 503 on the task1 grade endpoint.
    mockAgent
      .get(BASE_URL)
      .intercept({ method: 'POST', path: '/grading-feedback-task1' })
      .reply(503, {});
    mockAgent
      .get(BASE_URL)
      .intercept({ method: 'POST', path: '/grading-feedback-task2' })
      .reply(200, G2_RESPONSE);

    const webhookSink = jest.fn<Promise<void>, [WebhookPayload]>();

    const httpClient = new DownstreamHttpClient(BASE_URL, mockAgent);
    const result = await runCanary({
      httpClient,
      authorization: AUTH,
      webhookSink,
    });

    expect(result.outcome).toBe('unverified');

    const failure = result.failures.find(
      (f) => f.operation === 'writing.task1.grade',
    );
    expect(failure).toBeDefined();
    expect(failure?.class).toBe('http_5xx');

    expect(exitCodeForResult(result, false)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Exit code table
  // -------------------------------------------------------------------------
  describe('exitCodeForResult', () => {
    const makeResult = (outcome: CanaryResult['outcome']): CanaryResult => ({
      run_id: 'run_01',
      checked_at: new Date().toISOString(),
      outcome,
      successes: [],
      failures: [],
    });

    it('returns 0 for ok outcome', () => {
      expect(exitCodeForResult(makeResult('ok'), false)).toBe(0);
    });

    it('returns 1 for drift outcome', () => {
      expect(exitCodeForResult(makeResult('drift'), false)).toBe(1);
    });

    it('returns 2 for unverified outcome', () => {
      expect(exitCodeForResult(makeResult('unverified'), false)).toBe(2);
    });

    it('returns 3 when webhook failed regardless of outcome', () => {
      expect(exitCodeForResult(makeResult('drift'), true)).toBe(3);
      expect(exitCodeForResult(makeResult('unverified'), true)).toBe(3);
      expect(exitCodeForResult(makeResult('ok'), true)).toBe(3);
    });
  });
});
