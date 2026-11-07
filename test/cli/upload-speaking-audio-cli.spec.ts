import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/upload-speaking-audio.mjs', ...args],
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

// Issue #925 audit note: unknown and case-variant options must be rejected
// with a usage error, never silently ignored — `--dryrun` must not perform
// the real upload.
describe('upload-speaking-audio CLI', () => {
  it.each([['--dryrun'], ['--Dry-Run'], ['--endpointt']])(
    'rejects %s with a usage error before touching storage',
    async (flag) => {
      const result = await runScript([flag, 'true']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid CLI arguments');
      expect(result.stderr).not.toContain('SEAWEEDFS');
    },
  );

  // A bare `--dry-run` (no value) used to detect the flag by presence, so a
  // preview was never required; now a missing value is a usage error.
  it('rejects a bare --dry-run without a value', async () => {
    const result = await runScript(['--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid CLI arguments');
  });

  it('rejects a dry-run value that is not true or false', async () => {
    const result = await runScript(['--dry-run', 'yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid CLI arguments');
  });

  it('rejects a bare value without an option name', async () => {
    const result = await runScript(['just-a-value']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid CLI arguments');
  });

  it('rejects an option missing its value', async () => {
    const result = await runScript(['--source']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid CLI arguments');
  });
});
