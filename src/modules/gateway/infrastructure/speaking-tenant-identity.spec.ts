import providerResponse from '../../../../test/fixtures/ai-speaking/grading.response.json';

import { MockAgent, FormData as UndiciFormData } from 'undici/index.js';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type {
  RequestContext,
  UserIdentityMode,
} from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  SpeakingGradeInput,
  SpeakingGradeJsonInput,
} from '@/contracts/speaking/grading';
import { speakingGradingJsonAdapter } from '@/downstream/speaking/speaking-grading-json.adapter';
import { speakingGradingAdapter } from '@/downstream/speaking/speaking-grading.adapter';
import type { OperationDispatcherPort } from '@/modules/gateway/application/operation-dispatcher.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
  DispatchAttemptStart,
} from '@/modules/metering/public/dispatch-attempts';
import { DownstreamHttpClient } from './downstream-http.client';
import { createHttpOperationDispatcher } from './http-operation-dispatcher.testing';

const SPEAKING_URL = 'https://ai-speaking.test';
const CLIENT_ID = 'speaking-client';
const SECRET_KEY = 'speaking-secret';

const multipartInput: SpeakingGradeInput = {
  audio: {
    blob: new Blob(['synthetic audio']),
    filename: 'answer.wav',
    contentType: 'audio/wav',
  },
  part: 2,
  questionId: 'p2_favorite_place',
  promptText: 'Describe a place you like.',
  testType: 'Full-test',
  testCode: 'TEST-1441',
  transcript: 'A short synthetic transcript.',
};

const jsonInput: SpeakingGradeJsonInput = {
  audioUrl: 'https://s3.wispace.app/audio/synthetic.wav',
  part: 2,
  questionId: 'p2_favorite_place',
  promptText: 'Describe a place you like.',
  testType: 'Full-test',
  testCode: 'TEST-1441',
  transcript: 'A short synthetic transcript.',
};

interface ContextParts {
  readonly organizationId?: string;
  readonly userId?: string;
  readonly identityMode?: UserIdentityMode;
  readonly environment?: string;
}

/** A part left out is a part the context lacks; `'  '` is present but blank. */
function requestContext({
  organizationId,
  userId,
  identityMode,
  environment = 'test',
}: ContextParts): RequestContext {
  return createRequestContext({
    requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(userId === undefined ? {} : { userId }),
    ...(identityMode === undefined ? {} : { identityMode }),
    environment,
    scopes: [],
  });
}

function attemptsFake() {
  const starts: DispatchAttemptStart[] = [];
  const outcomes: Array<{
    readonly attemptId: string;
    readonly outcome: DispatchAttemptOutcome;
  }> = [];
  const beginAttempt = jest.fn(async (input: DispatchAttemptStart) => {
    starts.push(input);
    return 'attempt-test';
  });
  const recordOutcome = jest.fn(
    async (attemptId: string, outcome: DispatchAttemptOutcome) => {
      outcomes.push({ attemptId, outcome });
    },
  );
  const recorder: DispatchAttemptRecordPort = { beginAttempt, recordOutcome };
  return { recorder, starts, outcomes };
}

function sandboxBudgetFake() {
  const reserve = jest.fn(async () => true);
  const release = jest.fn(async () => undefined);
  const budget: SandboxDispatchBudgetPort = {
    reserve,
    release,
    allowanceFor: async () => null,
  };
  return { budget, reserve, release };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBody(body: unknown): Record<string, unknown> {
  const parsed: unknown =
    typeof body === 'string'
      ? JSON.parse(body)
      : body instanceof Uint8Array
        ? JSON.parse(new TextDecoder().decode(body))
        : undefined;
  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON Speaking request body');
  }
  return parsed;
}

function speakingDispatcher(
  mockAgent: MockAgent,
  attempts: DispatchAttemptRecordPort,
  sandboxBudget?: SandboxDispatchBudgetPort,
) {
  const httpClient = new DownstreamHttpClient(
    { 'ai-speaking': SPEAKING_URL },
    mockAgent,
    {
      'ai-speaking': { 'x-client-id': CLIENT_ID, 'x-secret-key': SECRET_KEY },
    },
  );
  const dispatcher = createHttpOperationDispatcher(
    httpClient,
    { mint: async () => 'unused' },
    [speakingGradingAdapter, speakingGradingJsonAdapter],
    attempts,
    sandboxBudget,
  );
  return { dispatcher, httpClient };
}

async function dispatchSpeaking(
  dispatcher: OperationDispatcherPort,
  operation: Extract<OperationId, 'speaking.grading' | 'speaking.grading-json'>,
  context: RequestContext,
) {
  if (operation === 'speaking.grading') {
    return dispatcher.dispatch(operation, multipartInput, context);
  }
  return dispatcher.dispatch(operation, jsonInput, context);
}

describe('Speaking tenant identity through the HTTP dispatcher', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it('sends the same End-User ID under each Organization for both Speaking operations', async () => {
    const tenants = [
      {
        organizationId: 'org_first',
        userId: 'same_end_user',
        identityMode: 'declared_id',
      },
      {
        organizationId: 'org_second',
        userId: 'same_end_user',
        identityMode: 'signed_assertion',
      },
    ] satisfies Array<{
      organizationId: string;
      userId: string;
      identityMode: UserIdentityMode;
    }>;
    const matchedRequests: Array<{
      operation: string;
      organizationId: string;
      userId: string;
      identityMode: UserIdentityMode;
    }> = [];
    const multipartBodies: UndiciFormData[] = [];
    const jsonBodies: Record<string, unknown>[] = [];

    for (const tenant of tenants) {
      for (const operation of [
        'speaking.grading',
        'speaking.grading-json',
      ] as const) {
        const path = OPERATION_CATALOG[operation].downstreamPath;
        mockAgent
          .get(SPEAKING_URL)
          .intercept({
            method: 'POST',
            path,
            headers: {
              'x-client-id': CLIENT_ID,
              'x-secret-key': SECRET_KEY,
              'x-aihub-organization-id': tenant.organizationId,
              'x-aihub-user-id': tenant.userId,
              'x-aihub-user-identity-mode': tenant.identityMode,
            },
          })
          .reply((request) => {
            matchedRequests.push({ operation, ...tenant });
            if (operation === 'speaking.grading') {
              if (!(request.body instanceof UndiciFormData)) {
                throw new Error('Expected multipart Speaking body');
              }
              multipartBodies.push(request.body);
            } else {
              jsonBodies.push(jsonBody(request.body));
            }
            return { statusCode: 200, data: providerResponse };
          });
      }
    }

    const { dispatcher } = speakingDispatcher(
      mockAgent,
      attemptsFake().recorder,
    );

    for (const tenant of tenants) {
      const context = requestContext(tenant);
      for (const operation of [
        'speaking.grading',
        'speaking.grading-json',
      ] as const) {
        await expect(
          dispatchSpeaking(dispatcher, operation, context),
        ).resolves.toMatchObject({ operation });
      }
    }

    expect(matchedRequests).toEqual(
      tenants.flatMap((tenant) =>
        (['speaking.grading', 'speaking.grading-json'] as const).map(
          (operation) => ({ operation, ...tenant }),
        ),
      ),
    );
    expect(multipartBodies).toHaveLength(2);
    for (const body of multipartBodies) {
      expect(Array.from(body.keys()).sort()).toEqual(
        [
          'audio',
          'part',
          'prompt_text',
          'question_id',
          'test_code',
          'test_type',
          'transcript',
          'user_id',
        ].sort(),
      );
      expect(body.get('user_id')).toBe('same_end_user');
      expect(body.get('part')).toBe('2');
      expect(body.get('question_id')).toBe('p2_favorite_place');
      expect(body.get('prompt_text')).toBe('Describe a place you like.');
      expect(body.get('test_type')).toBe('Full-test');
      expect(body.get('test_code')).toBe('TEST-1441');
      expect(body.get('transcript')).toBe('A short synthetic transcript.');
    }
    expect(jsonBodies).toEqual(
      tenants.map(() => ({
        user_id: 'same_end_user',
        part: 2,
        question_id: 'p2_favorite_place',
        audio_url: 'https://s3.wispace.app/audio/synthetic.wav',
        test_type: 'Full-test',
        prompt_text: 'Describe a place you like.',
        test_code: 'TEST-1441',
        transcript: 'A short synthetic transcript.',
      })),
    );
  });

  // The control for the refusals below: the same Sandbox dispatch with a
  // complete context does reserve and record, so "never reserved" means
  // preparation refused it and not that the fakes cannot be reached.
  it('reserves and records a complete Sandbox dispatch', async () => {
    mockAgent
      .get(SPEAKING_URL)
      .intercept({
        method: 'POST',
        path: OPERATION_CATALOG['speaking.grading-json'].downstreamPath,
      })
      .reply(200, providerResponse);
    const attempts = attemptsFake();
    const sandbox = sandboxBudgetFake();
    const { dispatcher } = speakingDispatcher(
      mockAgent,
      attempts.recorder,
      sandbox.budget,
    );

    await dispatchSpeaking(
      dispatcher,
      'speaking.grading-json',
      requestContext({
        organizationId: 'org_test',
        userId: 'same_end_user',
        identityMode: 'declared_id',
        environment: 'sandbox',
      }),
    );

    expect(sandbox.reserve).toHaveBeenCalledTimes(1);
    expect(attempts.starts).toHaveLength(1);
  });

  // Preparation runs before Sandbox admission and before the attempt record,
  // so a refused context leaves nothing reserved to release and nothing
  // recorded as sent.
  it.each([
    [
      'a missing Organization',
      { userId: 'same_end_user', identityMode: 'declared_id' },
      'INTERNAL_ERROR',
    ],
    [
      'a blank Organization',
      {
        organizationId: '  ',
        userId: 'same_end_user',
        identityMode: 'declared_id',
      },
      'INTERNAL_ERROR',
    ],
    [
      'a missing End-User ID',
      { organizationId: 'org_test', identityMode: 'declared_id' },
      'USER_IDENTITY_REQUIRED',
    ],
    [
      'a blank End-User ID',
      {
        organizationId: 'org_test',
        userId: '  ',
        identityMode: 'declared_id',
      },
      'USER_IDENTITY_REQUIRED',
    ],
    [
      'a missing identity mode',
      { organizationId: 'org_test', userId: 'same_end_user' },
      'INTERNAL_ERROR',
    ],
  ] as const)(
    'refuses %s on both Speaking operations before admission, attempts, or HTTP',
    async (_name, parts, code) => {
      for (const operation of [
        'speaking.grading',
        'speaking.grading-json',
      ] as const) {
        const attempts = attemptsFake();
        const sandbox = sandboxBudgetFake();
        const { dispatcher, httpClient } = speakingDispatcher(
          mockAgent,
          attempts.recorder,
          sandbox.budget,
        );
        const request = jest.spyOn(httpClient, 'request');

        await expect(
          dispatchSpeaking(
            dispatcher,
            operation,
            requestContext({ ...parts, environment: 'sandbox' }),
          ),
        ).rejects.toMatchObject({ code });

        expect(request).not.toHaveBeenCalled();
        expect(attempts.starts).toEqual([]);
        expect(attempts.outcomes).toEqual([]);
        expect(sandbox.reserve).not.toHaveBeenCalled();
        expect(sandbox.release).not.toHaveBeenCalled();
      }
    },
  );
});
