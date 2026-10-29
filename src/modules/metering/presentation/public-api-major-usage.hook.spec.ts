import Fastify, { type FastifyInstance } from 'fastify';

import type { PublicApiMajorUsageSample } from '@/modules/metering/application/public-api-major-usage';
import { registerPublicApiMajorUsage } from './public-api-major-usage.hook';

async function server(authenticatedAs?: string): Promise<{
  readonly instance: FastifyInstance;
  readonly samples: PublicApiMajorUsageSample[];
}> {
  const instance = Fastify();
  const samples: PublicApiMajorUsageSample[] = [];
  if (authenticatedAs !== undefined) {
    instance.addHook('onRequest', (request, _reply, done) => {
      Reflect.set(request, 'aihubAuth', { organizationId: authenticatedAs });
      done();
    });
  }
  registerPublicApiMajorUsage(instance, (sample) => samples.push(sample));
  instance.get('/v1/things/:id', async () => ({ ok: true }));
  instance.get('/v1/broken', async (_request, reply) =>
    reply.code(503).send({ ok: false }),
  );
  instance.get('/v2/things', async () => ({ ok: true }));
  instance.get('/v1/me', async () => ({ ok: true }));
  instance.post('/v1/ielts/writing/task1/grade', async () => ({ ok: true }));
  instance.get('/health', async () => ({ ok: true }));
  instance.get('/docs', async () => 'docs');
  await instance.ready();
  return { instance, samples };
}

describe('registerPublicApiMajorUsage', () => {
  it('records a completed request under its major and authenticated Organization', async () => {
    const { instance, samples } = await server('org_a');

    await instance.inject({ method: 'GET', url: '/v1/things/abc?x=secret' });
    await instance.inject({ method: 'GET', url: '/v2/things' });

    expect(samples).toMatchObject([
      { major: 1, organizationId: 'org_a', failed: false },
      { major: 2, organizationId: 'org_a', failed: false },
    ]);
    expect(samples[0]?.at).toBeInstanceOf(Date);
  });

  it('counts a failed response and leaves an unauthenticated request unattributed', async () => {
    const { instance, samples } = await server();

    await instance.inject({ method: 'GET', url: '/v1/broken' });
    await instance.inject({ method: 'GET', url: '/v1/missing-route' });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ major: 1, failed: true });
    expect(samples[0]).not.toHaveProperty('organizationId');
  });

  it('records how the matched route authenticates its caller, as the registries declare it', async () => {
    const { instance, samples } = await server();

    await instance.inject({ method: 'GET', url: '/v1/me' });
    await instance.inject({ method: 'HEAD', url: '/v1/me' });
    await instance.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
    });
    await instance.inject({ method: 'GET', url: '/v1/things/abc' });

    expect(samples.map((sample) => sample.callerKind)).toEqual([
      'bearer',
      'bearer',
      'api-key',
      'undeclared',
    ]);
  });

  it('ignores health probes, unversioned routes, and unmatched paths', async () => {
    const { instance, samples } = await server('org_a');

    await instance.inject({ method: 'GET', url: '/health' });
    await instance.inject({ method: 'GET', url: '/docs' });
    await instance.inject({ method: 'GET', url: '/v1/nothing-here/at-all' });

    expect(samples).toEqual([]);
  });
});
