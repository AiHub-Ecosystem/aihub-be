import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const {
  probeHost,
  requestCompletionId,
  startPublicHealthMonitor,
  validateHostname,
} = require('../../scripts/ops/monitoring/probe-public-edge.cjs') as {
  probeHost(
    this: void,
    hostname: string,
    fetchImpl?: typeof fetch,
  ): Promise<{ hostname: string; ok: boolean; result: string }>;
  requestCompletionId(
    this: void,
    hostname: string,
    fetchImpl?: typeof fetch,
  ): Promise<string>;
  startPublicHealthMonitor(
    this: void,
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
  validateHostname(this: void, hostname: string, label: string): string;
};

describe('public edge health probe', () => {
  it('runs public and dependency smoke checks through the blue-green CD helper', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/cd.yml'),
      'utf8',
    );
    const deployHelper = readFileSync(
      resolve(__dirname, '../../scripts/ops/blue-green/blue-green-host.sh'),
      'utf8',
    );
    const productionDeploy = workflow.slice(
      workflow.indexOf('      - name: Deploy Production and verify caller IP'),
      workflow.indexOf(
        '      - name: Deploy Sandbox release and verify caller IP',
      ),
    );
    const sandboxDeploy = workflow.slice(
      workflow.indexOf(
        '      - name: Deploy Sandbox release and verify caller IP',
      ),
      workflow.indexOf('      - name: Final public health window'),
    );

    expect(workflow).toContain(
      './scripts/ops/blue-green/blue-green-host.sh deploy',
    );
    expect(workflow).toContain(
      './scripts/ops/blue-green/blue-green-host.sh deploy production',
    );
    expect(workflow).toContain(
      './scripts/ops/blue-green/blue-green-host.sh deploy sandbox',
    );
    expect(workflow).toContain('already runs target; skipping cutover');
    expect(productionDeploy).toContain('"$caller_ip_gate" != production');
    expect(sandboxDeploy).toContain('"$caller_ip_gate" != production');
    expect(sandboxDeploy).toContain(
      "grep -Eq '^pending=|^sandbox enabled but not routed$'",
    );
    expect(sandboxDeploy).not.toContain('^(caller_ip_gate=|pending=)');
    expect(workflow).toContain('request-log-lookup.sh verify');
    expect(
      workflow.indexOf('      - name: Deploy Production and verify caller IP'),
    ).toBeLessThan(workflow.indexOf('      - name: Deploy Sandbox release'));
    expect(
      workflow.indexOf(
        '      - name: Deploy Sandbox release and verify caller IP',
      ),
    ).toBeLessThan(
      workflow.indexOf('      - name: Final public health window'),
    );
    expect(workflow).toContain(
      "steps.deploy_production.outputs.sandbox_enabled == 'true'",
    );
    expect(workflow).toContain("steps.deploy_sandbox.outcome == 'skipped'");
    expect(workflow).toContain('rollback_tier production');
    expect(workflow).toContain('rollback_tier sandbox');
    expect(workflow).toContain(
      './scripts/ops/blue-green/blue-green-host.sh recover-gate',
    );
    expect(workflow).toContain('deadline=$((SECONDS + 10))');
    expect(workflow).toContain('$VPS_APP_DIR/.aihub-host-jobs-candidate/');
    expect(workflow).toContain(
      'helper=./scripts/ops/blue-green/blue-green-host.sh',
    );
    expect(workflow).toContain('helper=./scripts/ops/blue-green-host.sh');
    expect(workflow).toContain('blue-green-host.path');
    expect(workflow).toContain(
      '"$APP_DIR/.aihub-host-jobs-candidate/install-host-jobs.sh" suspend',
    );
    expect(workflow).toContain(
      'active AIHUB tiers run mixed revisions; host jobs remain suspended',
    );
    expect(workflow).toContain(
      'if [[ "${active_shas[0]}" == "$target_sha" ]]; then',
    );
    expect(workflow).toContain('timeout-minutes: 45');
    expect(
      workflow.indexOf('      - name: Stage host job installer'),
    ).toBeLessThan(
      workflow.indexOf('      - name: Pause and drain AIHUB host jobs'),
    );
    expect(
      workflow.indexOf('      - name: Pause and drain AIHUB host jobs'),
    ).toBeLessThan(
      workflow.indexOf('      - name: Sync deployment files to VPS'),
    );
    expect(workflow).toContain('.aihub-host-jobs-sync-candidate');
    expect(workflow).toContain('scripts/ops/backups/backup-postgres.sh');
    expect(workflow).toContain(
      'scripts/ops/backups/restore-postgres-rehearsal.sh',
    );
    expect(workflow).toContain('"$target:$VPS_APP_DIR/scripts/ops/backups/"');
    expect(workflow).toContain(
      'Restore host files and schedule after sync failure',
    );
    expect(
      workflow.indexOf('      - name: Sync deployment files to VPS'),
    ).toBeLessThan(
      workflow.indexOf(
        '      - name: Restore host files and schedule after sync failure',
      ),
    );
    expect(
      workflow.indexOf(
        '      - name: Restore host files and schedule after sync failure',
      ),
    ).toBeLessThan(
      workflow.indexOf('      - name: Deploy Production and verify caller IP'),
    );
    expect(
      workflow.indexOf('      - name: Final public health window'),
    ).toBeLessThan(
      workflow.indexOf(
        '      - name: Install and smoke the scheduled host jobs',
      ),
    );
    expect(deployHelper).toContain('probe_all');
    expect(deployHelper).toContain('write_gate "$TIER"');
    expect(deployHelper).toContain('caller_ip_gate=');
    expect(deployHelper).toContain('recover-gate');
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

  it('requests the logged docs route and requires its AIHUB request ID', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      body: { cancel },
    });

    await expect(
      requestCompletionId('api.example.com', fetchImpl),
    ).resolves.toBe('req_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/docs',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(
      requestCompletionId(
        'api.example.com',
        jest.fn().mockResolvedValue({
          status: 200,
          headers: { get: () => null },
        }),
      ),
    ).rejects.toThrow(/request ID/);
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
