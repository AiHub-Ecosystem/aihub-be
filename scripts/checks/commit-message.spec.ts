import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(process.cwd(), 'scripts', 'checks', 'commit-message.mjs');

function run(message: string) {
  const directory = mkdtempSync(join(tmpdir(), 'aihub-commit-message-'));
  try {
    const file = join(directory, 'COMMIT_EDITMSG');
    writeFileSync(file, message);
    return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('commit message check', () => {
  it.each([
    'fix(gateway): bound the retry budget ledger',
    'docs: require English for content pushed to GitHub',
    'feat(api)!: drop the v1 response envelope',
    'chore: update dependencies',
  ])('accepts %s', (message) => {
    expect(run(message).status).toBe(0);
  });

  it.each([
    'Merge branch main into feature',
    'Revert "fix(gateway): bound the retry budget ledger"',
    'fixup! fix(gateway): bound the retry budget ledger',
    'squash! fix(gateway): bound the retry budget ledger',
  ])('exempts %s', (message) => {
    expect(run(message).status).toBe(0);
  });

  it.each([
    'Add bounded identity cache tiers',
    'fix:no space after the colon',
    'fix(gateway):',
    'fixed: a subject',
    'fix(Gateway): a subject',
  ])('rejects %s', (message) => {
    const result = run(message);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Commit message rejected');
  });

  it('rejects a header longer than the maximum', () => {
    const result = run(`fix(gateway): ${'x'.repeat(100)}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('maximum is 100');
  });

  it('reads the first non-comment line', () => {
    expect(run('# a comment\n\nfix(gateway): a subject\n').status).toBe(0);
  });

  it('rejects a message that only carries comments', () => {
    expect(run('# a comment\n').status).toBe(1);
  });
});
