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
      ['scripts/cli.mjs', ...args],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '' } },
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

const VALID = [
  '--org',
  'org_acme',
  '--owner',
  'acme-owner',
  '--actor',
  'aihub-ops-alice',
] as const;

describe('first owner attachment CLI', () => {
  it.each([
    ['no options', ['org:attach-owner']],
    [
      'a missing owner',
      ['org:attach-owner', '--org', 'org_acme', '--actor', 'aihub-ops-alice'],
    ],
    [
      'a missing actor',
      ['org:attach-owner', '--org', 'org_acme', '--owner', 'acme-owner'],
    ],
    ['an unknown option', ['org:attach-owner', ...VALID, '--role', 'admin']],
  ])(
    'rejects %s as invalid arguments without touching anything',
    async (_, args) => {
      const result = await runCli(args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Command failed');
    },
  );

  it('accepts --org, --owner, and --actor, failing operationally without a database', async () => {
    const result = await runCli(['org:attach-owner', ...VALID]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Command failed');
  });
});
