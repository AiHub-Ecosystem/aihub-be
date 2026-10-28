import { previousDeployedRelease } from './previous-deployed-release';

const runs = {
  workflow_runs: [
    {
      id: 3,
      head_branch: 'main',
      head_sha: '3'.repeat(40),
      event: 'workflow_run',
      conclusion: 'success',
    },
    {
      id: 2,
      head_branch: 'main',
      head_sha: '2'.repeat(40),
      event: 'workflow_run',
      conclusion: 'success',
    },
  ],
};

describe('previousDeployedRelease', () => {
  it('selects the newest successful CD run whose public health window passed', async () => {
    const fetchImpl = jest.fn<
      Promise<Response>,
      [string, RequestInit?]
    >() as unknown as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runs), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'Blue-green deploy to VPS',
                conclusion: 'success',
                steps: [
                  { name: 'Final public health window', conclusion: 'skipped' },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'Blue-green deploy to VPS',
                conclusion: 'success',
                steps: [
                  { name: 'Final public health window', conclusion: 'success' },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).resolves.toEqual({ runId: 2, sha: '2'.repeat(40) });
  });

  it('does not treat a successful CD workflow with a skipped deploy as a release', async () => {
    const fetchImpl = jest.fn<
      Promise<Response>,
      [string, RequestInit?]
    >() as unknown as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runs), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'Blue-green deploy to VPS',
                conclusion: 'success',
                steps: [
                  { name: 'Final public health window', conclusion: 'skipped' },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'Blue-green deploy to VPS',
                conclusion: 'success',
                steps: [
                  { name: 'Final public health window', conclusion: 'skipped' },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(
      previousDeployedRelease({
        repository: 'AiHub-Ecosystem/aihub-be',
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow('No successful deployed CD revision was found');
  });
});
