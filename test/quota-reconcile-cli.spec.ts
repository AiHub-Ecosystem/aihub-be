import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: '', REDIS_URL: '' },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      { cwd: process.cwd(), env },
      (error, _stdout, stderr) => {
        const code = error?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : 1,
          stderr,
        });
      },
    );
  });
}

describe('quota reconciliation CLI', () => {
  it('rejects an invalid month before opening infrastructure', async () => {
    const result = await runCli(['quota:reconcile', '--month', '2026-13']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Command failed');
  });

  it('fails with an operational error when Redis is not configured', async () => {
    const result = await runCli(['quota:reconcile'], {
      ...process.env,
      DATABASE_URL: 'postgres://unused',
      REDIS_URL: '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Command failed');
  });
});
