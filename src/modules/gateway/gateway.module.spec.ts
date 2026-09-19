import { readFileSync } from 'node:fs';
import { type IncomingHttpHeaders, createServer } from 'node:http';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';

import { createRequestContext } from '../../common/request-context/request-context.factory';
import type { SpeakingGradeInput } from '../../contracts/speaking/grading';
import type { GradeTask1Request } from '../../contracts/writing/grading';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '../secrets/application/runtime-secret-provider.port';
import {
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from './application/operation-dispatcher.port';
import { GatewayModule } from './gateway.module';

const FIXTURES = join(__dirname, '../../../test/fixtures');
const writingResponse = JSON.parse(
  readFileSync(join(FIXTURES, 'ai-writing/grade-task1.response.json'), 'utf8'),
) as unknown;
const speakingResponse = JSON.parse(
  readFileSync(join(FIXTURES, 'ai-speaking/grading.response.json'), 'utf8'),
) as unknown;

interface ObservedRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function header(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

describe('Gateway runtime-secret wiring', () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let moduleRef: TestingModule;
  let requests: ObservedRequest[];
  const originalUrls = {
    writing: process.env.DOWNSTREAM_AI_WRITING_URL,
    speaking: process.env.DOWNSTREAM_AI_SPEAKING_URL,
  };

  const snapshot = {
    aiSpeaking: {
      clientId: 'snapshot-speaking-client',
      secretKey: 'snapshot-speaking-secret',
    },
    aiWriting: { token: 'snapshot-writing-token' },
    resend: { apiKey: 'snapshot-resend-api-key' },
  } as const;
  const fakeProvider: RuntimeSecretProvider = {
    getSnapshot: () => snapshot,
  };

  beforeAll(async () => {
    requests = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          path: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            request.url === '/api/v1/speaking/grading'
              ? speakingResponse
              : writingResponse,
          ),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('gateway test server did not expose a port');
    }
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DOWNSTREAM_AI_WRITING_URL = origin;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = origin;

    moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    })
      .overrideProvider(RUNTIME_SECRET_PROVIDER)
      .useValue(fakeProvider)
      .compile();
  });

  afterAll(async () => {
    await moduleRef.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    process.env.DOWNSTREAM_AI_WRITING_URL = originalUrls.writing;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = originalUrls.speaking;
  });

  it('dispatches Writing and Speaking with the same startup snapshot', async () => {
    const dispatcher =
      moduleRef.get<OperationDispatcherPort>(OPERATION_DISPATCHER);
    const context = createRequestContext({
      requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      receivedAt: new Date(),
      deadlineMs: 10_000,
      userId: 'snapshot-user',
      scopes: [],
    });
    const writingInput: GradeTask1Request = {
      question: 'Describe the chart.',
      chart_type: 'Bar Chart',
      essay: 'A clear essay.',
      image_url: 'https://example.com/chart.png',
    };
    const speakingInput: SpeakingGradeInput = {
      audio: {
        bytes: Buffer.from('audio fixture'),
        filename: 'answer.wav',
        contentType: 'audio/wav',
      },
      part: 1,
      questionId: 'p1_hometown',
    };

    const writing = await dispatcher.dispatch(
      'writing.task1.grade',
      writingInput,
      context,
    );
    const speaking = await dispatcher.dispatch(
      'speaking.grading',
      speakingInput,
      context,
    );

    expect(writing.data.overall_band).toBe(7);
    expect(speaking.data.estimated_band.overall).toBe(6.5);
    expect(requests).toHaveLength(2);

    const writingRequest = requests.find(
      (request) => request.path === '/grading-feedback-task1',
    );
    const speakingRequest = requests.find(
      (request) => request.path === '/api/v1/speaking/grading',
    );
    expect(writingRequest).toBeDefined();
    expect(speakingRequest).toBeDefined();
    expect(header(writingRequest?.headers ?? {}, 'authorization')).toBe(
      `Bearer ${snapshot.aiWriting.token}`,
    );
    expect(header(speakingRequest?.headers ?? {}, 'x-client-id')).toBe(
      snapshot.aiSpeaking.clientId,
    );
    expect(header(speakingRequest?.headers ?? {}, 'x-secret-key')).toBe(
      snapshot.aiSpeaking.secretKey,
    );
    expect(speakingRequest?.body.toString()).toContain('snapshot-user');
  });
});
