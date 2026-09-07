import { Controller, Get } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from './app.module';
import { OPERATION_CATALOG } from './catalog/operation-catalog';
import { AppError } from './common/errors/app-error';
import { registerBodySizeGuard } from './common/http/body-size.hook';
import { generateRequestId } from './common/request-context/request-id';

@Controller('boom')
class BoomController {
  @Get()
  throwAppError(): never {
    throw new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'AI service is temporarily unavailable',
      httpStatus: 503,
      retryable: true,
    });
  }
}

describe('AppModule wiring', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoomController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health unversioned so probes do not depend on the API version', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('does not double the version prefix onto catalogued public paths', () => {
    for (const operation of Object.values(OPERATION_CATALOG)) {
      expect(operation.path).toMatch(/^\/v1\//);
      expect(operation.path).not.toMatch(/^\/v1\/v1\//);
    }
  });

  it('renders an AppError through the globally bound filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
      },
    });
  });

  it('reports an unknown route as 404 NOT_FOUND rather than 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    // Nest's own message would echo the route back to the caller.
    expect(response.payload).not.toContain('/nope');
  });

  it('stamps every response with a contract-shaped request id', async () => {
    const first = await app.inject({ method: 'GET', url: '/boom' });
    const second = await app.inject({ method: 'GET', url: '/boom' });

    const firstId = first.json().error.request_id;
    const secondId = second.json().error.request_id;

    expect(firstId).not.toBe(secondId);
    expect(firstId < secondId).toBe(true);
  });
});
