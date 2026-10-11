import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, REDIS_URL: '' },
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

describe('Redis TTL audit CLI', () => {
  it('rejects options before opening Redis', async () => {
    const result = await runCli(['redis:ttl-audit', '--dry-run', 'true']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Command failed');
  });

  it('fails when REDIS_URL is missing', async () => {
    const result = await runCli(['redis:ttl-audit']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Command failed');
  });
});
