import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { HealthController } from './health.controller';
import { READINESS_PROBES, type ReadinessProbe } from './readiness-probes';
import { ReadinessTerminusModule } from './readiness-terminus.module';

describe('HealthController', () => {
  let app: NestFastifyApplication;
  let probes: ReadinessProbe[];

  beforeEach(async () => {
    probes = [
      { name: 'runtime-postgres', check: async () => undefined },
      { name: 'redis', check: async () => undefined },
    ];

    const moduleRef = await Test.createTestingModule({
      imports: [ReadinessTerminusModule],
      controllers: [HealthController],
      providers: [{ provide: READINESS_PROBES, useFactory: () => probes }],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports each reachable dependency without extra Terminus metadata', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      dependencies: {
        'runtime-postgres': 'up',
        redis: 'up',
      },
    });
  });

  it('returns 503 and only dependency names and states when a check fails', async () => {
    probes[0]!.check = async () => {
      throw new Error('postgres://user:password@db.internal:5432/aihub');
    };

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.body;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      dependencies: {
        'runtime-postgres': 'down',
        redis: 'up',
      },
    });
    expect(body).not.toContain('password');
    expect(body).not.toContain('db.internal');
    expect(body).not.toContain('5432');
  });

  it('bounds a hung dependency check', async () => {
    probes[0]!.check = () => new Promise<void>(() => undefined);
    const startedAt = performance.now();

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies['runtime-postgres']).toBe('down');
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('keeps liveness independent from dependency failures', async () => {
    probes[0]!.check = async () => {
      throw new Error('database down');
    };

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
