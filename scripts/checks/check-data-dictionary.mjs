import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const committed = join(root, 'docs', 'data-dictionary.md');
const tmp = join(root, 'docs', '.data-dictionary.generated.md');

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'tsx',
    'scripts/generate/generate-data-dictionary.ts',
    'docs/.data-dictionary.generated.md',
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const a = readFileSync(committed, 'utf8');
const b = readFileSync(tmp, 'utf8');

try {
  unlinkSync(tmp);
} catch {}

if (a !== b) {
  console.error(
    'data-dictionary.md is out of date. Run `pnpm generate:data-dictionary`.',
  );
  process.exitCode = 1;
} else {
  console.log('data-dictionary.md is up to date.');
}
