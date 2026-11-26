import { spawnSync } from 'node:child_process';

function invoke(args: readonly string[]) {
  const result = spawnSync(process.execPath, ['scripts/cli/cli.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '' },
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    out: result.stdout ?? '',
    err: result.stderr ?? '',
  };
}

describe('avatar recovery CLI', () => {
  it('refuses a run without explicit review and target confirmation', () => {
    for (const args of [
      [],
      ['--reviewed', 'true'],
      ['--target', 'production'],
    ]) {
      const result = invoke(['avatar:recover', ...args]);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Invalid CLI arguments');
    }
  });

  it('stops at the database preflight before any recovery pass', () => {
    const result = invoke([
      'avatar:recover',
      '--reviewed',
      'true',
      '--target',
      'production',
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('operator database URL is required');
    expect(result.out).not.toContain('avatar_recovery_pass');
  });
});
