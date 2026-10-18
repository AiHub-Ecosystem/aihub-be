import { spawnSync } from 'node:child_process';

describe('generate-prisma-client fast path', () => {
  it('skips regeneration on a consecutive run with unchanged inputs', () => {
    const run = () =>
      spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        [
          'exec',
          'node',
          'scripts/generate/generate-prisma-client.mjs',
          '--runtime',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          shell: process.platform === 'win32',
        },
      );

    run();
    const second = run();
    expect(second.stdout + second.stderr).toMatch(/skipping regeneration/);
    expect(second.status).toBe(0);
  });
});
