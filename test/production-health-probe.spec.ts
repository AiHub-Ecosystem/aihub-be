const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { probeProductionHealth } =
  require('../scripts/ops/probe-production-health.cjs') as {
    probeProductionHealth: (hostname?: string) => Promise<boolean>;
  };

describe('production health probe', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.spyOn(global, 'fetch').mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries redirects and HTTP failures until it gets a 2xx response', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://redirect.example.com' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const probe = probeProductionHealth('api.example.com');
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(probe).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/health',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 302'),
    );
  });

  it('retries after a request timeout', async () => {
    fetchMock
      .mockImplementationOnce(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('request aborted')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const probe = probeProductionHealth('api.example.com');
    await jest.advanceTimersByTimeAsync(15_000);

    await expect(probe).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not wait for a stalled response body cancellation', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel: () => new Promise<void>(() => undefined),
        }),
        { status: 200 },
      ),
    );

    await expect(probeProductionHealth('api.example.com')).resolves.toBe(true);
  });

  it('stops after the two-minute wall-clock deadline', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const probe = probeProductionHealth('api.example.com');
    await jest.advanceTimersByTimeAsync(120_000);

    await expect(probe).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('attempts=24'),
    );
  });

  it('fails immediately when the production hostname is missing', async () => {
    await expect(probeProductionHealth()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('AIHUB_PRODUCTION_HOST is required'),
    );
  });

  it('fails immediately when the production hostname is malformed', async () => {
    await expect(probeProductionHealth('-api.example.com')).resolves.toBe(
      false,
    );
    await expect(probeProductionHealth('api..example.com')).resolves.toBe(
      false,
    );
    await expect(probeProductionHealth('a'.repeat(254))).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the public probe after deployment with the production hostname variable', () => {
    const workflow = readFileSync(
      join(__dirname, '../.github/workflows/cd.yml'),
      'utf8',
    );
    expect(workflow).toContain('- name: Verify production health URL');
    expect(workflow).toContain(
      'AIHUB_PRODUCTION_HOST: ${{ vars.AIHUB_PRODUCTION_HOST }}',
    );
    expect(workflow).toContain('node scripts/ops/probe-production-health.cjs');
  });
});
