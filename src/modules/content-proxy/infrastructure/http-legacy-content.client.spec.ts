import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Headers, Response, type fetch as undiciFetch } from 'undici/index.js';

import { HttpLegacyContentClient } from './http-legacy-content.client';

const BASE_URL = 'https://backend.example.invalid';

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

/** A fetch that answers every call with `body` and records what was asked. */
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

describe('HttpLegacyContentClient', () => {
  it('sends the task type and drops the template author from the result', async () => {
    const { fetchFn, calls } = stubFetch(
      fixture('writing-template-task1.200.json'),
    );

    const result = await new HttpLegacyContentClient(
      `${BASE_URL}/`,
      fetchFn,
    ).fetchWritingTemplates('task 1');

    expect(calls).toEqual([
      { url: `${BASE_URL}/api/WritingTemplate`, taskType: 'task 1' },
    ]);
    expect(result.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/"user(Id|Name)"/);
  });

  it('forwards Speaking library paging', async () => {
    const { fetchFn, calls } = stubFetch(fixture('speaking-library.200.json'));

    const result = await new HttpLegacyContentClient(
      BASE_URL,
      fetchFn,
    ).fetchSpeakingLibrary({ page: '1', pageSize: '10' });

    expect(calls[0]?.url).toBe(
      `${BASE_URL}/api/Speaking/library?page=1&pageSize=10`,
    );
    expect(result.page).toBe(1);
  });

  it.each([
    ['fetchListeningTests', '/v1/listening/tests', 'listening-tests.200.json'],
    ['fetchReadingTests', '/v1/reading/tests', 'reading-tests.200.json'],
  ] as const)('%s calls %s', async (method, path, file) => {
    const { fetchFn, calls } = stubFetch(fixture(file));

    const result = await new HttpLegacyContentClient(BASE_URL, fetchFn)[method](
      { limit: '5' },
    );

    expect(calls[0]?.url).toBe(`${BASE_URL}${path}?limit=5`);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('refuses a body that does not match the public schema', async () => {
    const { fetchFn } = stubFetch(JSON.stringify({ invalid: true }));

    await expect(
      new HttpLegacyContentClient(BASE_URL, fetchFn).fetchWritingTemplates(
        'task 1',
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
  });

  it.each([
    [503, 'AI_SERVICE_UNAVAILABLE', true],
    [404, 'AI_SERVICE_ERROR', false],
  ] as const)('maps upstream %d to %s', async (status, code, retryable) => {
    const { fetchFn } = stubFetch('upstream error', status);

    await expect(
      new HttpLegacyContentClient(BASE_URL, fetchFn).fetchListeningTests(),
    ).rejects.toMatchObject({ code, retryable, downstreamStatus: status });
  });

  it('maps a timeout to AI_SERVICE_TIMEOUT', async () => {
    const fetchFn: typeof undiciFetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };

    await expect(
      new HttpLegacyContentClient(BASE_URL, fetchFn).fetchReadingTests(),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT', retryable: true });
  });
});
