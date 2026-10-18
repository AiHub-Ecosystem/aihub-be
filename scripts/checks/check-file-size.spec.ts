import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('file-size ceiling check', () => {
  const scratchDir = join(process.cwd(), 'src', '__file_size_check__');
  const scratchFile = join(scratchDir, 'big.ts');

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('fails when a new hand-written file exceeds the ceiling', () => {
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      scratchFile,
      Array.from({ length: 501 }, (_, i) => `export const x${i} = ${i};`).join(
        '\n',
      ),
    );

    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-file-size.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(
      /exceeds the 500-line ceiling/,
    );
  });

  it('passes on the real tree', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-file-size.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    expect(result.status).toBe(0);
  });
});
