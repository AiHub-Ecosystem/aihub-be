import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Headers, Response, type fetch as undiciFetch } from 'undici/index.js';

import { HttpLegacyContentClient } from './http-legacy-content.client';

const BASE_URL = 'https://backend.example.invalid';
const REQ_ID = 'req_01J00000000000000000000000';

function fixture(filename: string): string {
  return readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'legacy-backend', filename),
    'utf8',
  );
}

interface Recorded {
  readonly url: string;
  readonly taskType: string | null;
}

function stubFetch(
  body: string,
  status = 200,
): { fetchFn: typeof undiciFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn: typeof undiciFetch = async (input, init) => {
    calls.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      taskType: new Headers(init?.headers).get('x-task-type'),
    });
    return new Response(body, { status });
  };
  return { fetchFn, calls };
}

describe('HttpLegacyContentClient /v2', () => {
  it('fetches Task 1 templates, applies cursor pagination and snake_case mapping', async () => {
    const { fetchFn, calls } = stubFetch(
      fixture('writing-template-task1.200.json'),
    );

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    const result = await client.fetchWritingTask1Templates(5, 1, REQ_ID);

    expect(calls).toEqual([
      { url: `${BASE_URL}/api/WritingTemplate`, taskType: 'task 1' },
    ]);
    expect(result.data.templates).toHaveLength(5);
    expect(result.data.next_cursor).toBe('eyJwYWdlIjoyfQ');
    expect(result.meta.request_id).toBe(REQ_ID);

    const first = result.data.templates[0];
    expect(first?.task_type).toBe('Task 1');
    expect(first?.image_url).toBeDefined();
    expect(first?.type_id).toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/"user(Id|Name)"/);
  });

  it('fetches Task 2 templates without image_url', async () => {
    const { fetchFn, calls } = stubFetch(
      fixture('writing-template-task2.200.json'),
    );

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    const result = await client.fetchWritingTask2Templates(50, 1, REQ_ID);

    expect(calls).toEqual([
      { url: `${BASE_URL}/api/WritingTemplate`, taskType: 'task 2' },
    ]);
    expect(result.data.templates.length).toBeGreaterThan(0);
    expect(result.data.next_cursor).toBeNull();

    const first = result.data.templates[0];
    expect(first?.task_type).toBe('Task 2');
    expect(
      (first as unknown as Record<string, unknown>)['image_url'],
    ).toBeUndefined();
  });

  it('forwards Speaking library paging and maps to topics', async () => {
    const { fetchFn, calls } = stubFetch(fixture('speaking-library.200.json'));

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    const result = await client.fetchSpeakingLibrary(10, 1, REQ_ID);

    expect(calls[0]?.url).toBe(
      `${BASE_URL}/api/Speaking/library?page=1&pageSize=10`,
    );
    expect(result.data.topics.length).toBeGreaterThan(0);
    expect(result.data.next_cursor).toBe('eyJwYWdlIjoyfQ');

    const first = result.data.topics[0];
    expect(first?.original_id).toBeDefined();
    expect(first?.created_at).toBeDefined();
    expect(first?.permanent_topic).toBeDefined();
  });

  it('fetches Listening tests with cursor pagination', async () => {
    const { fetchFn, calls } = stubFetch(fixture('listening-tests.200.json'));

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    const result = await client.fetchListeningTests(5, 1, REQ_ID);

    expect(calls[0]?.url).toBe(
      `${BASE_URL}/v1/listening/tests?page=1&pageSize=5`,
    );
    expect(result.data.tests.length).toBeGreaterThan(0);
    expect(result.data.next_cursor).toBeNull();
  });

  it('fetches Reading tests with cursor pagination', async () => {
    const { fetchFn, calls } = stubFetch(fixture('reading-tests.200.json'));

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    const result = await client.fetchReadingTests(5, 1, REQ_ID);

    expect(calls[0]?.url).toBe(
      `${BASE_URL}/v1/reading/tests?page=1&pageSize=5`,
    );
    expect(result.data.tests.length).toBeGreaterThan(0);
    expect(result.data.next_cursor).toBe('eyJwYWdlIjoyfQ');
  });

  it('refuses invalid JSON as AI_SERVICE_CONTRACT_VIOLATION', async () => {
    const { fetchFn } = stubFetch('<html>bad gateway</html>');

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    await expect(
      client.fetchSpeakingLibrary(10, 1, REQ_ID),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_CONTRACT_VIOLATION',
      retryable: false,
    });
  });

  it('maps timeout while streaming body to AI_SERVICE_TIMEOUT', async () => {
    const fetchFn: typeof undiciFetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
            controller.error(new DOMException('timed out', 'TimeoutError'));
          },
        }),
      );

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    await expect(
      client.fetchListeningTests(10, 1, REQ_ID),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
      retryable: true,
    });
  });

  it('releases body of refused upstream response', async () => {
    let cancelled = false;
    const fetchFn: typeof undiciFetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 502 },
      );

    const client = new HttpLegacyContentClient(BASE_URL, fetchFn);
    await expect(client.fetchReadingTests(10, 1, REQ_ID)).rejects.toMatchObject(
      {
        code: 'AI_SERVICE_UNAVAILABLE',
        downstreamStatus: 502,
      },
    );
    expect(cancelled).toBe(true);
  });
});
