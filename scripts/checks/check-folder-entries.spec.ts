import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'check-folder-entries.mjs',
);

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function entries(count: number): string {
  return Array.from({ length: count }, (_, i) => `entry-${i}.mjs`).join('\n');
}

// Each case builds its own tree: a scratch folder inside the real `scripts/`
// would race the other checks that scan it from parallel Jest workers.
function runOnFixture(dirs: Record<string, number>) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-folder-entries-'));
  try {
    for (const [dir, count] of Object.entries(dirs)) {
      mkdirSync(join(fixtureRoot, dir), { recursive: true });
      for (const name of entries(count).split('\n'))
        writeFileSync(join(fixtureRoot, dir, name), '');
    }
    const result = runCheck(fixtureRoot);
    return { status: result.status, output: result.stderr + result.stdout };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('folder-entry ceiling check', () => {
  it('fails when a scripts root gains an entry past its ceiling', () => {
    const result = runOnFixture({ 'scripts/cli': 16 });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /scripts\/cli holds 16 direct entries against the 15-entry ceiling/,
    );
    expect(result.output).toMatch(
      /AGENTS\.md: "Keep each root at 15 direct entries or fewer"/,
    );
  });

  it('passes at the ceiling', () => {
    const result = runOnFixture({ 'scripts/cli': 15 });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Folder-entry ceiling check passed/);
  });

  it('fails when a layer folder exceeds the 20-entry ceiling', () => {
    const result = runOnFixture({ 'src/modules/example/application': 21 });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /src\/modules\/example\/application holds 21 direct entries against the 20-entry ceiling/,
    );
    expect(result.output).toMatch(
      /AGENTS\.md: layer folders under src\/modules\/ hold 20 direct entries or fewer/,
    );
  });

  it('passes a layer folder at the ceiling', () => {
    const result = runOnFixture({ 'src/modules/example/application': 20 });

    expect(result.status).toBe(0);
  });

  it('caps a feature subfolder of a layer folder', () => {
    const result = runOnFixture({
      'src/modules/metering/infrastructure/billing': 21,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /src\/modules\/metering\/infrastructure\/billing holds 21 direct entries against the 20-entry ceiling/,
    );
  });

  it('passes a grandfathered folder within its recorded baseline and prints the record', () => {
    const result = runOnFixture({ 'scripts/checks': 62 });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(
      /scripts\/checks is grandfathered at 62 direct entries against its ceiling/,
    );
    expect(result.output).toMatch(/#1770 tracks the reduction/);
  });

  it('fails when a grandfathered folder grows past its recorded baseline', () => {
    const result = runOnFixture({ 'scripts/checks': 63 });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /grandfathered at 62 \([^)]*#1770 tracks the reduction[^)]*\) and may not grow/,
    );
  });

  it('reports an allowlisted folder measured back within its ceiling', () => {
    const result = runOnFixture({ 'scripts/checks': 10 });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(
      /scripts\/checks is back within its ceiling at 10 direct entries; remove it from the allowlist/,
    );
  });

  it('does not cap directories outside the stated scope', () => {
    const result = runOnFixture({
      'src/modules/auth/testing': 22,
      'test/db/auth': 22,
      'scripts/ci/n-minus-one': 20,
    });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Folder-entry ceiling check passed/);
  });
});
