import { previousDeployedRelease } from './previous-deployed-release';

function workflowRun(
  id: number,
  sha: string,
  status = 'completed',
  conclusion: string | null = 'success',
) {
  return {
    id,
    head_branch: 'main',
    head_sha: sha,
    event: 'workflow_run',
    status,
    conclusion,
    created_at: '2026-10-28T03:00:00Z',
    updated_at: '2026-10-28T03:00:00Z',
  };
}

function ciRun(id: number, sha: string, updatedAt: string) {
  return {
    ...workflowRun(id, sha),
    event: 'push',
    updated_at: updatedAt,
  };
}

function queuedFetch(
  ...payloads: unknown[]
): jest.MockedFunction<typeof fetch> {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>();
  for (const payload of payloads) {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
  }
  return fetchImpl as unknown as jest.MockedFunction<typeof fetch>;
}

function productionStep(conclusion: string) {
  return {
    name: 'Deploy Production and verify caller IP',
    conclusion,
  };
}

function sandboxStep(conclusion: string) {
  return {
    name: 'Deploy Sandbox release and verify caller IP',
    conclusion,
  };
}

function finalHealth(conclusion: string) {
  return { name: 'Final public health window', conclusion };
}

describe('previousDeployedRelease', () => {
  it('selects a Production cutover even when the later Sandbox deploy fails', async () => {
    const fetchImpl = queuedFetch(
      {
        workflow_runs: [
          workflowRun(3, '3'.repeat(40), 'completed', 'failure'),
          workflowRun(2, '2'.repeat(40)),
        ],
      },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'failure',
            steps: [
              productionStep('success'),
              sandboxStep('failure'),
              finalHealth('skipped'),
            ],
          },
        ],
      },
      { artifacts: [] },
      {
        workflow_runs: [ciRun(4, '3'.repeat(40), '2026-10-28T02:59:00Z')],
      },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'success',
            steps: [sandboxStep('success'), finalHealth('success')],
          },
        ],
      },
      { artifacts: [] },
      { workflow_runs: [ciRun(1, '2'.repeat(40), '2026-10-28T02:59:00Z')] },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).resolves.toEqual({
      production: { runId: 3, sha: '3'.repeat(40), digestRunId: 4 },
      sandbox: { runId: 2, sha: '2'.repeat(40), digestRunId: 1 },
    });
  });

  it('falls back when the Production cutover did not pass', async () => {
    const fetchImpl = queuedFetch(
      {
        workflow_runs: [
          workflowRun(3, '3'.repeat(40), 'completed', 'failure'),
          workflowRun(2, '2'.repeat(40)),
        ],
      },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'failure',
            steps: [productionStep('failure')],
          },
        ],
      },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'success',
            steps: [
              productionStep('success'),
              sandboxStep('success'),
              finalHealth('success'),
            ],
          },
        ],
      },
      { artifacts: [] },
      {
        workflow_runs: [ciRun(1, '2'.repeat(40), '2026-10-28T02:59:00Z')],
      },
      { artifacts: [] },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).resolves.toEqual({
      production: { runId: 2, sha: '2'.repeat(40), digestRunId: 1 },
      sandbox: { runId: 2, sha: '2'.repeat(40), digestRunId: 1 },
    });
  });

  it('fails closed when the Production final health window rolls back', async () => {
    const fetchImpl = queuedFetch(
      { workflow_runs: [workflowRun(3, '3'.repeat(40))] },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'failure',
            steps: [
              productionStep('success'),
              sandboxStep('success'),
              finalHealth('failure'),
            ],
          },
        ],
      },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(
      'CD run 3 failed its final public health window after Production cutover; active revision is unresolved',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the exact digest artifact recorded by the Production CD run', async () => {
    const fetchImpl = queuedFetch(
      { workflow_runs: [workflowRun(3, '3'.repeat(40))] },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'success',
            steps: [
              productionStep('success'),
              sandboxStep('success'),
              finalHealth('success'),
            ],
          },
        ],
      },
      { artifacts: [{ name: 'image-digest', expired: false }] },
      { artifacts: [{ name: 'image-digest', expired: false }] },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).resolves.toEqual({
      production: { runId: 3, sha: '3'.repeat(40), digestRunId: 3 },
      sandbox: { runId: 3, sha: '3'.repeat(40), digestRunId: 3 },
    });
  });

  it('fails closed when the Production release digest has no matching CI publication', async () => {
    const fetchImpl = queuedFetch(
      { workflow_runs: [workflowRun(3, '3'.repeat(40))] },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'success',
            steps: [
              productionStep('success'),
              sandboxStep('success'),
              finalHealth('success'),
            ],
          },
        ],
      },
      { artifacts: [] },
      { workflow_runs: [] },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(
      'CI image digest cannot be uniquely recovered for deployed release ' +
        '3'.repeat(40),
    );
  });

  it('fails closed when legacy CD history cannot distinguish successful CI builds for one SHA', async () => {
    const sha = '3'.repeat(40);
    const fetchImpl = queuedFetch(
      { workflow_runs: [workflowRun(3, sha)] },
      {
        jobs: [
          {
            name: 'Blue-green deploy to VPS',
            conclusion: 'success',
            steps: [
              productionStep('success'),
              sandboxStep('success'),
              finalHealth('success'),
            ],
          },
        ],
      },
      { artifacts: [] },
      {
        workflow_runs: [
          ciRun(5, sha, '2026-10-28T02:59:30Z'),
          ciRun(4, sha, '2026-10-28T02:59:00Z'),
        ],
      },
    );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(
      `CI image digest cannot be uniquely recovered for deployed release ${sha}`,
    );
  });

  it('fails closed while a CD run may still change the rollback target', async () => {
    const fetchImpl = queuedFetch({
      workflow_runs: [workflowRun(4, '4'.repeat(40), 'in_progress', null)],
    });

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow('CD run 4 is still active; retry after it completes');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).not.toEqual(
      expect.stringContaining('status='),
    );
  });
});
