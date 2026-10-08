import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: '' },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      { cwd: process.cwd(), env },
      (error, stdout, stderr) => {
        const code = error?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe('usage prune CLI', () => {
  it('emits a safe configuration failure and exits operationally', async () => {
    const result = await runCli(['usage:prune']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"event":"usage_prune_failed"');
    expect(result.stdout).toContain('"error_code":"CONFIGURATION_MISSING"');
    expect(result.stdout).not.toContain('DATABASE_URL');
    expect(result.stderr).toContain('Command failed');
  });

  it('rejects operator overrides as invalid arguments', async () => {
    const result = await runCli([
      'usage:prune',
      '--database-url',
      'postgres://secret',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  });
});
