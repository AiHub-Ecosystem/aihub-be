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
  }, 15_000);

  it('rejects an unknown option before any database work', async () => {
    const result = await runCli(['idempotency:cleanup', '--bogus', 'x']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid CLI arguments');
  }, 15_000);

  it('refuses a dry run and a target confirmation without a database', async () => {
    const preview = await runCli(['idempotency:cleanup', '--dry-run', 'true']);
    const targeted = await runCli([
      'idempotency:cleanup',
      '--target',
      'production',
    ]);

    for (const result of [preview, targeted]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('operator database URL is required');
      expect(result.stderr).not.toContain('idempotency_cleanup_completed');
    }
  }, 15_000);
});
