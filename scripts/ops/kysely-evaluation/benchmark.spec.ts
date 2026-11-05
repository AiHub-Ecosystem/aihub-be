import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Kysely RSS benchmark isolation', () => {
  it('leaves Kysely out of the Prisma baseline child process', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/ops/kysely-evaluation/benchmark.mjs'),
        '--rss',
        'prismaRaw',
        '--assert-no-kysely',
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
    expect(result.stderr).toBe('no Kysely modules loaded\n');
  });
});
