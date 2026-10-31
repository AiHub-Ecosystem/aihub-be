import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Response } from 'undici/index.js';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import { speakingGradingJsonAdapter } from '@/downstream/speaking/speaking-grading-json.adapter';
import { speakingGradingAdapter } from '@/downstream/speaking/speaking-grading.adapter';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';

import {
  requestContractFailures,
  requestSchema,
} from './support/provider-request-contract';

type Json = Record<string, unknown>;
function jsonObject(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object');
  }
  return value as Json;
}
const doc = jsonObject(
  JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures/ai-speaking/provider-openapi.snapshot.json'),
      'utf8',
    ),
  ),
);
const capture: unknown = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/ai-speaking/grading.response.json'),
    'utf8',
  ),
);
const context = createRequestContext({
  requestId: 'req_speaking_contract',
  receivedAt: new Date(),
  deadlineMs: 5000,
  organizationId: 'org_contract',
  userId: 'server-derived-user',
  identityMode: 'declared_id',
  scopes: [],
});

async function onWire(request: DownstreamRequest): Promise<{
  body: Json;
  contentType: string;
  response: unknown;
  file: { name: string; type: string; text: string } | undefined;
  identityHeaders: Record<string, string>;
}> {
  let body: Json = {};
  let contentType = '';
  let file: { name: string; type: string; text: string } | undefined;
  let identityHeaders: Record<string, string> = {};
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value)) throw new Error('expected bytes');
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      contentType = incoming.headers['content-type'] ?? '';
      identityHeaders = {
        organization: String(incoming.headers['x-aihub-organization-id'] ?? ''),
        user: String(incoming.headers['x-aihub-user-id'] ?? ''),
        mode: String(incoming.headers['x-aihub-user-identity-mode'] ?? ''),
      };
      if (contentType.startsWith('multipart/form-data')) {
        const form = await new Response(bytes, {
          headers: { 'content-type': contentType },
        }).formData();
        for (const [key, value] of form.entries()) {
          body[key] = typeof value === 'string' ? value : value.name;
          if (typeof value !== 'string')
            file = {
              name: value.name,
              type: value.type,
              text: await value.text(),
            };
        }
        // Multipart encodes scalar fields as text; the provider parses part as an integer.
        if (typeof body.part === 'string' && /^\d+$/.test(body.part))
          body.part = Number(body.part);
      } else {
        body = jsonObject(JSON.parse(bytes.toString('utf8')));
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(capture));
    })().catch((error: unknown) =>
      outgoing.destroy(
        error instanceof Error ? error : new Error('test server failed'),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('missing test server address');
  const client = new DownstreamHttpClient(`http://127.0.0.1:${address.port}`);
  try {
    const response = await client.request(request, {
      requestId: context.requestId,
      deadlineMs: 5000,
      signal: AbortSignal.timeout(5000),
    });
    return {
      body,
      contentType,
      response: response.body,
      file,
      identityHeaders,
    };
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const audio = {
  blob: new Blob(['synthetic audio']),
  filename: 'answer.wav',
  contentType: 'audio/wav',
};
const cases = [
  {
    operation: 'speaking.grading',
    media: 'multipart/form-data',
    file: { name: 'answer.wav', type: 'audio/wav', text: 'synthetic audio' },
    adapter: speakingGradingAdapter,
    requests: [
      speakingGradingAdapter.buildRequest(
        { audio, part: 1, questionId: 'q1' },
        context,
      ),
      speakingGradingAdapter.buildRequest(
        {
          audio,
          part: 3,
          questionId: 'q3',
          promptText: 'prompt',
          testType: 'Full-test',
          testCode: 'test',
          transcript: 'words',
        },
        context,
      ),
      speakingGradingAdapter.buildRequest(
        { audio, part: 2, questionId: 'q2', testType: 'Practice' },
        context,
      ),
    ],
  },
  {
    operation: 'speaking.grading-json',
    media: 'application/json',
    file: undefined,
    adapter: speakingGradingJsonAdapter,
    requests: [
      speakingGradingJsonAdapter.buildRequest(
        {
          audioUrl: 'https://s3.wispace.app/audio.wav',
          part: 1,
          questionId: 'q1',
        },
        context,
      ),
      speakingGradingJsonAdapter.buildRequest(
        {
          audioUrl: 'https://s3.wispace.app/audio.wav',
          part: 3,
          questionId: 'q3',
          promptText: 'prompt',
          testType: 'Full-test',
          testCode: 'test',
          transcript: 'words',
        },
        context,
      ),
      speakingGradingJsonAdapter.buildRequest(
        {
          audioUrl: 'https://s3.wispace.app/audio.wav',
          part: 2,
          questionId: 'q2',
          promptText: null,
          testCode: null,
          transcript: null,
        },
        context,
      ),
    ],
  },
];

describe.each(cases)(
  '$operation provider request contract',
  ({ operation, media, adapter, requests, file }) => {
    it('accepts minimal, populated and alternative values produced on the wire', async () => {
      for (const request of requests) {
        const wire = await onWire(request);
        expect(wire.contentType).toMatch(new RegExp(`^${media}`));
        expect(wire.identityHeaders).toEqual({
          organization: 'org_contract',
          user: 'server-derived-user',
          mode: 'declared_id',
        });
        expect(wire.file).toEqual(file);
        expect(wire.body.user_id).toBe('server-derived-user');
        expect(
          requestContractFailures(doc, request.path, media, wire.body),
        ).toEqual([]);
        expect(
          typeof adapter.parseResponse({
            status: 200,
            headers: {},
            body: wire.response,
          }).question_id,
        ).toBe('string');
      }
    });

    it('preserves omission and the transport default for minimal requests', async () => {
      const request = requests[0];
      if (request === undefined) throw new Error('missing minimal request');
      const wire = await onWire(request);
      expect(wire.body).not.toHaveProperty('prompt_text');
      expect(wire.body).not.toHaveProperty('test_code');
      expect(wire.body).not.toHaveProperty('transcript');
      expect(wire.body.test_type).toBe(
        operation === 'speaking.grading-json' ? 'Practice' : undefined,
      );
      expect(Object.hasOwn(wire.body, 'test_type')).toBe(
        operation === 'speaking.grading-json',
      );
    });

    it('preserves populated optional metadata', async () => {
      const request = requests[1];
      if (request === undefined) throw new Error('missing populated request');
      const wire = await onWire(request);
      expect(wire.body).toMatchObject({
        prompt_text: 'prompt',
        test_type: 'Full-test',
        test_code: 'test',
        transcript: 'words',
      });
    });

    it('detects a new required field and a narrowed value without rejecting a wider provider', async () => {
      const request = requests[1];
      if (request === undefined) throw new Error('missing populated request');
      const wire = await onWire(request);
      const changed: Json = structuredClone(doc);
      const schema = requestSchema(changed, request.path, media);
      schema.required = [
        ...(schema.required as string[]),
        'new_required_field',
      ];
      expect(
        requestContractFailures(changed, request.path, media, wire.body),
      ).toContain(
        ": required must have required property 'new_required_field'",
      );
      schema.required = (schema.required as string[]).filter(
        (field) => field !== 'new_required_field',
      );
      const properties = schema.properties as Json;
      properties.test_type = { type: 'string', enum: ['Practice'] };
      expect(
        requestContractFailures(changed, request.path, media, wire.body),
      ).toContain(
        '/test_type: enum must be equal to one of the allowed values',
      );
      properties.test_type = { type: 'string' };
      properties.new_optional_field = { type: 'string' };
      expect(
        requestContractFailures(changed, request.path, media, wire.body),
      ).toEqual([]);
    });
  },
);

it('relies on the provider Practice default when multipart omits test_type', () => {
  const request = cases[0]?.requests[0];
  if (request === undefined) throw new Error('missing multipart request');
  const properties = jsonObject(
    requestSchema(doc, request.path, 'multipart/form-data').properties,
  );
  expect(jsonObject(properties.test_type).default).toBe('Practice');
});

it('preserves nullable optional metadata in JSON', async () => {
  const request = cases[1]?.requests[2];
  if (request === undefined) throw new Error('missing nullable request');
  const wire = await onWire(request);
  expect(wire.body).toMatchObject({
    prompt_text: null,
    test_code: null,
    transcript: null,
  });
});
