import { type ExecutionContext, Module } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { createAppFastifyProxyOptions } from '@/app-fastify-proxy-options';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  CONTENT_RATE_LIMITER,
  type ContentRateLimitDecision,
  type ContentRateLimiterPort,
} from '@/modules/content-proxy/application/content-rate-limiter.port';
import {
  FETCH_LEGACY_CONTENT_PORT,
  type FetchLegacyContentPort,
} from '@/modules/content-proxy/application/legacy-content.port';
import { ContentProxyController } from '@/modules/content-proxy/presentation/content-proxy.controller';
import { ContentRateLimitGuard } from '@/modules/content-proxy/presentation/content-rate-limit.guard';
import { HttpExceptionFilter } from '@/modules/metering/public/http-exception-filter';

const TRUSTED_PROXY = '172.16.7.1';
const CLIENT_IP = '198.51.100.10';
const OTHER_CLIENT_IP = '198.51.100.11';
const FORGED_IP = '203.0.113.250';
const ROUTES = [
  '/v2/ielts/writing/task1/templates',
  '/v2/ielts/writing/task2/templates',
  '/v2/ielts/speaking/library',
  '/v2/ielts/listening/tests',
  '/v2/ielts/reading/tests',
] as const;

class CountingRateLimiter implements ContentRateLimiterPort {
  private readonly counts = new Map<string, number>();

  async consume(clientIp: string): Promise<ContentRateLimitDecision> {
    const count = (this.counts.get(clientIp) ?? 0) + 1;
    this.counts.set(clientIp, count);
    return count <= 30
      ? { allowed: true }
      : { allowed: false, retryAfterMs: 24_500 };
  }
}

const content: FetchLegacyContentPort = {
  async fetchWritingTask1Templates(_limit, _page, requestId) {
    return {
      data: { templates: [], next_cursor: null },
      meta: { request_id: requestId },
    };
  },
  async fetchWritingTask2Templates(_limit, _page, requestId) {
    return {
      data: { templates: [], next_cursor: null },
      meta: { request_id: requestId },
    };
  },
  async fetchSpeakingLibrary(_limit, _page, requestId) {
    return {
      data: { topics: [], next_cursor: null },
      meta: { request_id: requestId },
    };
  },
  async fetchListeningTests(_limit, _page, requestId) {
    return {
      data: { tests: [], next_cursor: null },
      meta: { request_id: requestId },
    };
  },
  async fetchReadingTests(_limit, _page, requestId) {
    return {
      data: { tests: [], next_cursor: null },
      meta: { request_id: requestId },
    };
  },
};

@Module({
  controllers: [ContentProxyController],
  providers: [
    ContentRateLimitGuard,
    {
      provide: CONTENT_RATE_LIMITER,
      useValue: new CountingRateLimiter(),
    },
    { provide: FETCH_LEGACY_CONTENT_PORT, useValue: content },
  ],
})
class ContentProxyRateLimitTestModule {}

describe('IELTS content rate limit HTTP behavior', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ContentProxyRateLimitTestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        ...createAppFastifyProxyOptions(TRUSTED_PROXY),
        genReqId: generateRequestId,
      }),
    );
    app.useGlobalFilters(
      new HttpExceptionFilter({ finalize: async () => undefined }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the shared unknown address bucket when Fastify has no client IP', async () => {
    const consumed: string[] = [];
    const guard = new ContentRateLimitGuard({
      async consume(clientIp) {
        consumed.push(clientIp);
        return { allowed: true };
      },
    });
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ ip: undefined }) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consumed).toEqual(['unknown']);
  });

  it('counts all five routes by the trusted client address before query validation', async () => {
    const invalid = await request(ROUTES[0], CLIENT_IP, '?limit=0');
    expect(invalid.statusCode).toBe(400);

    for (let index = 0; index < 29; index += 1) {
      const route = ROUTES[index % ROUTES.length] ?? ROUTES[0];
      const response = await request(route, CLIENT_IP);
      expect(response.statusCode).toBe(200);
    }

    const blocked = await request(ROUTES[4], CLIENT_IP);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('25');
    expect(blocked.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true, retry_after_ms: 24_500 },
    });

    const otherClient = await request(ROUTES[4], OTHER_CLIENT_IP);
    expect(otherClient.statusCode).toBe(200);
  });

  function request(route: string, clientIp: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `${route}${query}`,
      remoteAddress: TRUSTED_PROXY,
      headers: { 'x-forwarded-for': `${FORGED_IP}, ${clientIp}` },
    });
  }
});
