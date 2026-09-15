import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';

import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { registerBodySizeGuard } from './body-size.hook';

const CATALOGUED_PATH = OPERATION_CATALOG['writing.task1.grade'].path;
const LIMIT = OPERATION_CATALOG['writing.task1.grade'].maxBodyBytes;
const JSON_PATH = OPERATION_CATALOG['speaking.grading-json'].path;
const JSON_LIMIT = OPERATION_CATALOG['speaking.grading-json'].maxBodyBytes;

describe('registerBodySizeGuard', () => {
  let app: FastifyInstance;
  let handlerCalls: number;

  beforeEach(async () => {
    handlerCalls = 0;
    app = Fastify();
    registerBodySizeGuard(app);
    app.post(CATALOGUED_PATH, async () => {
      handlerCalls += 1;
      return { ok: true };
    });
    app.post(JSON_PATH, async () => {
      handlerCalls += 1;
      return { ok: true };
    });
    app.post('/v1/uncatalogued', async () => {
      handlerCalls += 1;
      return { ok: true };
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a declared Content-Length over the operation limit before the handler runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: CATALOGUED_PATH,
      headers: {
        'content-type': 'application/json',
        'content-length': String(LIMIT + 1),
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
        request_id: 'unknown',
        retryable: false,
      },
    });
    expect(handlerCalls).toBe(0);
  });

  it('allows a request within the operation limit through to the handler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: CATALOGUED_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it('does not apply a limit to a path outside the catalog', async () => {
    // A genuine payload well over the catalogued limit but still comfortably
    // under Fastify's own default ceiling, so this exercises "no limit
    // applies" rather than "the global ceiling happened to allow it".
    const largePayload = JSON.stringify({ padding: 'x'.repeat(LIMIT * 2) });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uncatalogued',
      headers: { 'content-type': 'application/json' },
      payload: largePayload,
    });

    expect(response.statusCode).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it('rejects a chunked JSON body over the operation limit before parsing', async () => {
    const largePayload = JSON.stringify({
      padding: 'x'.repeat(JSON_LIMIT),
    });

    const response = await app.inject({
      method: 'POST',
      url: JSON_PATH,
      headers: { 'content-type': 'application/json' },
      payload: Readable.from([largePayload]),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    expect(handlerCalls).toBe(0);
  });
});
