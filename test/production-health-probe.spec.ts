const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { probeProductionHealth } =
  require('../scripts/probe-production-health.cjs') as {
    probeProductionHealth: (hostname?: string) => Promise<boolean>;
  };

describe('production health probe', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries redirects and HTTP failures until it gets a 2xx response', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 302, body: null })
      .mockResolvedValueOnce({ status: 503, body: null })
      .mockResolvedValueOnce({ status: 204, body: null });

    const probe = probeProductionHealth('api.example.com');
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(probe).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
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
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new Error('request aborted')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ status: 200, body: null });

    const probe = probeProductionHealth('api.example.com');
    await jest.advanceTimersByTimeAsync(15_000);

    await expect(probe).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the two-minute wall-clock deadline', async () => {
    fetchMock.mockResolvedValue({ status: 503, body: null });

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

  it('runs the public probe after deployment with the production hostname variable', () => {
    const workflow = readFileSync(
      join(__dirname, '../.github/workflows/cd.yml'),
      'utf8',
    );
    const deployRelease = workflow.indexOf('- name: Deploy release');
    const probe = workflow.indexOf('- name: Verify production health URL');
    const logout = workflow.indexOf('- name: Log out of GHCR on VPS');
    const probeStep = workflow.slice(probe, logout);

    expect(deployRelease).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(deployRelease);
    expect(logout).toBeGreaterThan(probe);
    expect(probeStep).toContain(
      'AIHUB_PRODUCTION_HOST: ${{ vars.AIHUB_PRODUCTION_HOST }}',
    );
    expect(probeStep).toContain('node scripts/probe-production-health.cjs');
  });
});
