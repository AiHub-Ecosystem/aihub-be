import Fastify, { type FastifyInstance } from 'fastify';

import type { SheddingLevelPort } from '@/modules/gateway/application/shedding/shedding-level.port';
import { registerSheddingGuard } from '@/modules/gateway/presentation/shedding.hook';

const GRADE_PATH = '/v1/ielts/writing/task1/grade';
const LOGIN_PATH = '/v1/auth/login';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly retryable: boolean;
    readonly retry_after_ms: number;
  };
}

function errorBodyOf(body: string): ErrorBody {
  return JSON.parse(body) as ErrorBody;
}

class FixedLevel implements SheddingLevelPort {
  constructor(private level: number) {}

  current(): number {
    return this.level;
  }

  set(level: number): void {
    this.level = level;
  }
}

describe('registerSheddingGuard', () => {
  let app: FastifyInstance;
  let level: FixedLevel;
  let handled: number;
  let bodyRead: number;
  let recorded: string[];

  beforeEach(async () => {
    handled = 0;
    bodyRead = 0;
    recorded = [];
    level = new FixedLevel(0);
    app = Fastify();
    registerSheddingGuard(app, level, (tier, outcome) => {
      recorded.push(`${tier}:${outcome}`);
    });
    app.post(GRADE_PATH, async (request) => {
      handled += 1;
      await request.body;
      bodyRead += 1;
      return { ok: true };
    });
    app.post(LOGIN_PATH, async () => {
      handled += 1;
      return { ok: true };
    });
    app.get('/v1/ielts/speaking/questions', async () => {
      handled += 1;
      return { ok: true };
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('admits everything at level 0', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_PATH,
      payload: { essay: 'text' },
    });

    expect(response.statusCode).toBe(200);
    expect(handled).toBe(1);
    expect(recorded).toEqual(['best-effort:admitted']);
  });

  it('refuses a best-effort request with 503, Retry-After, and no body read', async () => {
    level.set(1);
    const response = await app.inject({
      method: 'POST',
      url: GRADE_PATH,
      payload: { essay: 'text' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toMatch(/^[0-9]+$/);
    const body = errorBodyOf(response.body);
    expect(body).toMatchObject({
      error: {
        code: 'SERVICE_OVERLOADED',
        retryable: true,
      },
    });
    expect(body.error.retry_after_ms).toBeGreaterThan(0);
    expect(handled).toBe(0);
    expect(bodyRead).toBe(0);
    expect(recorded).toEqual(['best-effort:shed']);
  });

  it('keeps critical requests answering at every level', async () => {
    level.set(2);
    const response = await app.inject({
      method: 'POST',
      url: LOGIN_PATH,
      payload: { email: 'a@b.test', password: 'secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(handled).toBe(1);
  });

  it('sheds standard only from level 2', async () => {
    level.set(1);
    const admitted = await app.inject({
      method: 'GET',
      url: '/v1/ielts/speaking/questions',
    });
    expect(admitted.statusCode).toBe(200);

    level.set(2);
    const shed = await app.inject({
      method: 'GET',
      url: '/v1/ielts/speaking/questions',
    });
    expect(shed.statusCode).toBe(503);
  });

  it('leaves the retry hint the same shape as the header', async () => {
    level.set(2);
    const response = await app.inject({
      method: 'POST',
      url: GRADE_PATH,
      payload: {},
    });

    const header = Number(response.headers['retry-after']);
    expect(header).toBe(
      Math.ceil(errorBodyOf(response.body).error.retry_after_ms / 1_000),
    );
  });
});
