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

describe('organization suspension CLI', () => {
  it.each([
    ['no options', ['org:suspend']],
    ['a missing actor', ['org:suspend', '--org', 'org_acme']],
    ['a missing Organization', ['org:restore', '--actor', 'aihub-ops-alice']],
    [
      'an unknown option',
      [
        'org:restore',
        '--org',
        'org_acme',
        '--actor',
        'aihub-ops-alice',
        '--reason',
        'paid',
      ],
    ],
  ])(
    'rejects %s as invalid arguments without touching anything',
    async (_, args) => {
      const result = await runCli(args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Command failed');
    },
  );

  it.each(['org:suspend', 'org:restore'])(
    'accepts %s with --org and --actor, failing operationally without a database',
    async (command) => {
      const result = await runCli([
        command,
        '--org',
        'org_acme',
        '--actor',
        'aihub-ops-alice',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Command failed');
    },
  );
});
