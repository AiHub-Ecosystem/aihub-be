import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
          AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: '',
          DATABASE_URL: '',
        },
        timeout: 15_000,
      },
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

describe('writing chart revocation CLI', () => {
  it('dispatches the command and rejects invalid URLs before database access', async () => {
    const result = await runCli([
      'writing:chart-revoke',
      '--url',
      'http://s3.wispace.app/aihub-sandbox-writing-charts/writing-charts/chart_01J00000000000000000000001/published',
      '--actor',
      'operator',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  }, 20_000);

  it('requires the operator account and uses the selected Sandbox scope', async () => {
    const result = await runCli([
      'writing:chart-revoke',
      '--url',
      'https://s3.wispace.app/aihub-sandbox-writing-charts/writing-charts/chart_01J00000000000000000000001/published',
      '--actor',
      'operator',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
    expect(result.stderr).not.toContain('s3.wispace.app');
  }, 20_000);
});
