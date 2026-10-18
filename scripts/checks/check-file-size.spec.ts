import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(process.cwd(), 'scripts', 'checks', 'check-file-size.mjs');

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('file-size ceiling check', () => {
  // The failing case builds its own tree: a scratch file inside the real `src/`
  // races the other checks that scan it from parallel Jest workers.
  it('fails when a new hand-written file exceeds the ceiling', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-file-size-'));
    try {
      mkdirSync(join(fixtureRoot, 'src'));
      writeFileSync(
        join(fixtureRoot, 'src', 'big.ts'),
        Array.from(
          { length: 501 },
          (_, i) => `export const x${i} = ${i};`,
        ).join('\n'),
      );

      const result = runCheck(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(
        /exceeds the 500-line ceiling/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  });
});
