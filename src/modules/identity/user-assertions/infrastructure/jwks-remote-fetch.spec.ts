import { Agent, fetch as undiciFetch } from 'undici/index.js';

import { defaultJwksFetcher, fetchRemoteJwks } from './jwks-remote-fetch';

jest.mock('undici/index.js', () => ({
  Agent: jest.fn(),
  fetch: jest.fn(),
}));

const jwks = {
  keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB', alg: 'RS256', kid: 'rsa-1' }],
};

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

const jwksResponse = {
  ok: true,
  status: 200,
  headers: { get: () => null },
  body: new Response(JSON.stringify(jwks)).body,
} as unknown as UndiciResponse;

const resolverFactory = () => ({
  resolve4: async () => ['8.8.8.8'],
  resolve6: async () => [],
  cancel: () => undefined,
});

describe('fetchRemoteJwks IP pinning (#1867)', () => {
  it('gives the agent the pinned lookup, so the hostname cannot resolve elsewhere', async () => {
    const dispatcher = { close: async () => undefined };
    jest.mocked(Agent).mockImplementation(() => dispatcher as unknown as Agent);
    jest.mocked(undiciFetch).mockResolvedValue(jwksResponse);

    await fetchRemoteJwks(
      'https://id.acme.edu/.well-known/jwks.json',
      defaultJwksFetcher,
      resolverFactory,
    );

    const agentOptions = (
      jest.mocked(Agent).mock.calls as unknown as [
        {
          connect: {
            lookup: (
              hostname: string,
              options: { all?: boolean },
              callback: (
                error: NodeJS.ErrnoException | null,
                addresses: { address: string; family: number }[],
              ) => void,
            ) => void;
          };
        },
      ][]
    )[0]?.[0];
    const connect = agentOptions?.connect;
    if (connect === undefined) {
      throw new Error('the agent was built without connect options');
    }
    expect(connect.lookup).toEqual(expect.any(Function));

    const answers: { address: string; family: number }[][] = [];
    connect.lookup('id.acme.edu', { all: true }, (_error, addresses) => {
      answers.push(addresses);
    });
    expect(answers).toEqual([[{ address: '8.8.8.8', family: 4 }]]);

    const fetchInit = (
      jest.mocked(undiciFetch).mock.calls as unknown as [
        string,
        { dispatcher: unknown },
      ][]
    )[0]?.[1];
    expect(fetchInit?.dispatcher).toBe(dispatcher);
  });
});

describe('fetchRemoteJwks against a hung source', () => {
  it('gives up at the 3 s fetch deadline with a retryable IDENTITY_JWKS_SOURCE_UNAVAILABLE', async () => {
    jest
      .mocked(Agent)
      .mockImplementation(
        () => ({ close: async () => undefined }) as unknown as Agent,
      );
    let aborted: unknown;
    // A source that accepts the request and never answers: only the fetch
    // deadline can end it.
    const hung: Parameters<typeof fetchRemoteJwks>[1] = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = init.signal?.reason;
          reject(init.signal?.reason);
        });
      });

    const startedAt = performance.now();
    // real-timer-ok: the deadline under test is AbortSignal.timeout, which fake timers do not drive
    const failure = await fetchRemoteJwks(
      'https://id.acme.edu/.well-known/jwks.json',
      hung,
      resolverFactory,
    ).catch((error: unknown) => error);
    const elapsedMs = performance.now() - startedAt;

    expect(failure).toMatchObject({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(aborted).toMatchObject({ name: 'TimeoutError' });
    expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
    expect(elapsedMs).toBeLessThan(3_500);
  }, 10_000);
});
