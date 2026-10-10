import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { probeHost, startPublicHealthMonitor, validateHostname } =
  require('../../scripts/ops/probe-public-edge.cjs') as {
    probeHost(
      hostname: string,
      fetchImpl?: typeof fetch,
    ): Promise<{ hostname: string; ok: boolean; result: string }>;
    startPublicHealthMonitor(
      hosts: { tier: string; hostname: string }[],
      options?: {
        fetchImpl?: typeof fetch;
        intervalMs?: number;
        onFailure?: (failure: { hostname: string; result: string }) => void;
      },
    ): {
      readonly failures: { hostname: string; result: string }[];
      readonly samples: number;
      stop(): Promise<{
        failures: { hostname: string; result: string }[];
        samples: number;
      }>;
    };
    validateHostname(hostname: string, label: string): string;
  };

describe('public edge health probe', () => {
  it('runs public and dependency smoke checks through the blue-green CD helper', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/cd.yml'),
      'utf8',
    );
    const deployHelper = readFileSync(
      resolve(__dirname, '../../scripts/ops/blue-green-host.sh'),
      'utf8',
    );

    expect(workflow).toContain('./scripts/ops/blue-green-host.sh deploy');
    expect(deployHelper).toContain('probe_all');
    expect(deployHelper).toContain('deploy_tier production');
    expect(deployHelper).toContain('deploy_tier sandbox');
    expect(deployHelper).toContain('probe_container_dependencies');
  });

  it('accepts a DNS hostname and rejects URL or path input', () => {
    expect(validateHostname('api.example.com', 'host')).toBe('api.example.com');
    expect(() => validateHostname('https://api.example.com', 'host')).toThrow(
      'host hostname must be a DNS hostname',
    );
    expect(() => validateHostname('api.example.com/ready', 'host')).toThrow(
      'host hostname must be a DNS hostname',
    );
  });

  it('checks the public health route without following redirects or reading bodies', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      body: { cancel },
    });

    await expect(probeHost('api.example.com', fetchImpl)).resolves.toEqual({
      hostname: 'api.example.com',
      ok: true,
      result: 'HTTP 200',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/health',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('records the tier hostname when a public probe fails', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 503,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    });
    const monitor = startPublicHealthMonitor(
      [{ tier: 'sandbox', hostname: 'sandbox.example.com' }],
      { fetchImpl, intervalMs: 10 },
    );

    await jest.advanceTimersByTimeAsync(1);
    const result = await monitor.stop();

    expect(result.failures).toEqual([
      { hostname: 'sandbox.example.com', result: 'HTTP 503' },
    ]);
    expect(result.samples).toBe(1);
    jest.useRealTimers();
  });
});
