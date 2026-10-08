import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: '' },
      },
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

describe('idempotency cleanup CLI', () => {
  it('fails with an operational error when the database is not configured', async () => {
    const result = await runCli(['idempotency:cleanup']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Command failed');
  });
});
