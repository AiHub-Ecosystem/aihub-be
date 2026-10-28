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
              {
                name: 'Deploy Sandbox release and verify caller IP',
                conclusion: 'failure',
              },
              { name: 'Final public health window', conclusion: 'skipped' },
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
    ).resolves.toEqual({ runId: 3, sha: '3'.repeat(40) });
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
            steps: [productionStep('success')],
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
    ).resolves.toEqual({ runId: 2, sha: '2'.repeat(40) });
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
