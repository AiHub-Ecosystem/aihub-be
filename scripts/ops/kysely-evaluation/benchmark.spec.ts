import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const benchmark = readFileSync(
  join(root, 'scripts/ops/kysely-evaluation/benchmark.mjs'),
  'utf8',
);

describe('Kysely RSS benchmark isolation', () => {
  it('runs the Prisma RSS baseline before loading the Kysely module', () => {
    const baselineStart = benchmark.indexOf("if (mode === 'prismaRaw') {");
    const kyselyLoad = benchmark.indexOf(
      'loadKyselyBenchmarkModule();',
      baselineStart,
    );
    const baseline = benchmark.slice(baselineStart, kyselyLoad);

    expect(baselineStart).toBeGreaterThanOrEqual(0);
    expect(kyselyLoad).toBeGreaterThan(baselineStart);
    expect(baseline).toContain(
      'await pool.query(QUOTA_RECONCILIATION_SQL, [from, to])',
    );
    expect(baseline).toContain('return;');
  });
});
