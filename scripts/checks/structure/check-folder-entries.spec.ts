import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'structure',
  'check-folder-entries.mjs',
);

function runCheck(cwd: string, env?: Record<string, string>) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    status: result.status,
    output: `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`,
  };
}

function entries(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `entry-${i}.mjs`);
}

// Each case builds its own tree: a scratch folder inside the real `scripts/`
// would race the other checks that scan it from parallel Jest workers.
function runOnFixture(
  dirs: Record<string, number>,
  env?: Record<string, string>,
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-folder-entries-'));
  try {
    for (const [dir, count] of Object.entries(dirs)) {
      mkdirSync(join(fixtureRoot, dir), { recursive: true });
      for (const name of entries(count))
        writeFileSync(join(fixtureRoot, dir, name), '');
    }
    const result = runCheck(fixtureRoot, env);
    return result;
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

  it('caps a feature subfolder of a layer folder', () => {
    const result = runOnFixture({
      'src/modules/metering/infrastructure/billing': 21,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /src\/modules\/metering\/infrastructure\/billing holds 21 direct entries against the 20-entry ceiling/,
    );
  });

  it('fails when a module testing folder exceeds the 20-entry ceiling (#1821)', () => {
    const result = runOnFixture({ 'src/modules/auth/testing': 21 });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /src\/modules\/auth\/testing holds 21 direct entries against the 20-entry ceiling/,
    );
  });

  it('passes a module testing folder at the ceiling (#1821)', () => {
    const result = runOnFixture({ 'src/modules/auth/testing': 20 });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Folder-entry ceiling check passed/);
  });

  it('caps a concern subfolder of a module testing folder (#1821)', () => {
    const result = runOnFixture({ 'src/modules/auth/testing/http': 21 });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /src\/modules\/auth\/testing\/http holds 21 direct entries against the 20-entry ceiling/,
    );
  });

  it('does not cap directories outside the stated scope', () => {
    const result = runOnFixture({
      'test/db/auth': 22,
      'scripts/ci/n-minus-one': 20,
    });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Folder-entry ceiling check passed/);
  });

  describe('allowlist', () => {
    const allowlist = JSON.stringify({
      'scripts/checks': { baseline: 62, note: '#1770 tracks the reduction' },
    });

    it('grandfathers a listed folder within its recorded baseline', () => {
      const result = runOnFixture(
        { 'scripts/checks': 62 },
        { FOLDER_ENTRIES_ALLOWLIST: allowlist },
      );

      expect(result.status).toBe(0);
      expect(result.output).toMatch(
        /scripts\/checks is grandfathered at 62 direct entries against its ceiling/,
      );
    });

    it('fails a listed folder that grows past its recorded baseline', () => {
      const result = runOnFixture(
        { 'scripts/checks': 63 },
        { FOLDER_ENTRIES_ALLOWLIST: allowlist },
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(
        /grandfathered at 62 \([^)]*#1770 tracks the reduction[^)]*\) and may not grow/,
      );
    });

    it('reports a listed folder measured back within its ceiling', () => {
      const result = runOnFixture(
        { 'scripts/checks': 10 },
        { FOLDER_ENTRIES_ALLOWLIST: allowlist },
      );

      expect(result.status).toBe(0);
      expect(result.output).toMatch(
        /scripts\/checks is back within its ceiling at 10 direct entries; remove it from the allowlist/,
      );
    });

    it('carries no live allowlist entries once the reductions have landed', () => {
      // The check runs on the real tree in CI; if someone records a new
      // grandfathered folder there, this run starts reporting it.
      const result = runCheck(process.cwd());

      expect(result.status).toBe(0);
      expect(result.output).not.toMatch(/grandfathered/);
      expect(result.output).not.toMatch(/remove it from the allowlist/);
    });
  });
});
