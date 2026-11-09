import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'knip',
  'check-declaration-registry.mjs',
);

function runCheck(cwd: string) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`,
  };
}

/**
 * A knip.json with a single `entry` array, written as JSONC so the reason
 * comment each entry carries is exercised by the parser instead of avoided.
 */
function knipJson(entries: string[]): string {
  const lines = entries.map(
    (entry) =>
      `    // Hand-written types for ${entry} — same reason.\n    "${entry}",`,
  );
  return `{\n  "entry": [\n${lines.join('\n')}\n  ]\n}\n`;
}

/**
 * Each case builds its own tree: a scratch folder inside the real `scripts/`
 * would race the other checks that scan it from parallel Jest workers.
 */
function runOnFixture(files: {
  declarations?: string[];
  entries?: string[];
  knip?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), 'aihub-declaration-registry-'));
  try {
    for (const rel of files.declarations ?? []) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), 'export {};\n');
    }
    writeFileSync(
      join(root, 'knip.json'),
      files.knip ?? knipJson(files.entries ?? []),
    );
    return runCheck(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DECLARATION_EXEMPT = '.dependency-cruiser.d.cts';

describe('hand-written declaration registry check', () => {
  it('passes when every declaration has its knip entry and every entry a file', () => {
    const result = runOnFixture({
      declarations: ['scripts/cli/cli-options.d.cts'],
      entries: ['scripts/cli/cli-options.d.cts'],
    });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Declaration-registry check passed/);
  });

  it('fails a hand-written declaration that has no knip entry', () => {
    const result = runOnFixture({
      declarations: ['scripts/cli/cli-options.d.cts'],
      entries: [],
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /hand-written declarations with no knip\.json entry/,
    );
    expect(result.output).toMatch(/scripts\/cli\/cli-options\.d\.cts/);
  });

  it('fails a knip entry that names a missing declaration', () => {
    const result = runOnFixture({
      declarations: [],
      entries: ['scripts/cli/removed.d.cts'],
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /knip\.json entries naming a declaration that does not exist/,
    );
    expect(result.output).toMatch(/scripts\/cli\/removed\.d\.cts/);
  });

  it('fails an entry whose reason comment is missing', () => {
    const result = runOnFixture({
      declarations: ['scripts/cli/cli-options.d.cts'],
      knip: `{\n  "entry": [\n    "scripts/cli/cli-options.d.cts"\n  ]\n}\n`,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /knip\.json entries carrying no reason comment/,
    );
    expect(result.output).toMatch(/scripts\/cli\/cli-options\.d\.cts/);
  });

  it('reports every reasonless entry, not only the first', () => {
    const result = runOnFixture({
      declarations: ['a.d.cts', 'b.d.mts'],
      knip: `{\n  "entry": [\n    "a.d.cts",\n    "b.d.mts"\n  ]\n}\n`,
    });

    const listed = result.output.slice(
      result.output.indexOf('carrying no reason comment'),
    );
    expect(listed).toMatch(/a\.d\.cts/);
    expect(listed).toMatch(/b\.d\.mts/);
  });

  it('exempts the declaration its source lives beside', () => {
    // `.dependency-cruiser.d.cts` types `.dependency-cruiser.cjs` at the same
    // path, so TypeScript's adjacent-declaration lookup finds it without a
    // knip entry.
    const result = runOnFixture({
      declarations: [
        DECLARATION_EXEMPT,
        DECLARATION_EXEMPT.replace('.d.cts', '.cjs'),
      ],
      entries: [],
    });

    expect(result.status).toBe(0);
  });

  it('ignores entries that are not hand-written declarations', () => {
    const result = runOnFixture({
      declarations: [],
      entries: ['src/main.ts', 'scripts/runtime/runtime-entrypoint.mjs'],
    });

    expect(result.status).toBe(0);
  });

  it('fails a declaration nested anywhere in the tree, not only the scripts roots', () => {
    const result = runOnFixture({
      declarations: ['ops/vault/budget.d.mts'],
      entries: [],
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(
      /hand-written declarations with no knip\.json entry/,
    );
    expect(result.output).toMatch(/ops\/vault\/budget\.d\.mts/);
  });

  it('fails loudly when knip.json cannot be read', () => {
    const result = runOnFixture({ knip: '{ not json' });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/declaration-registry:/);
  });

  it('passes on the repository as it stands', () => {
    const result = runCheck(process.cwd());

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Declaration-registry check passed/);
  });

  // knip's `entry` accepts a `{path, reason}` object as well as a bare string.
  // Reading only the string form parsed an object entry to nothing and then
  // reported every declaration as unlisted, which is a false failure.
  it('reads an object-form entry, reason included', () => {
    const objectEntry = (fields: string) =>
      runOnFixture({
        declarations: ['scripts/cli/cli-options.d.cts'],
        knip: `{\n  "entry": [\n    {${fields}}\n  ]\n}\n`,
      });

    // A reason inside the object satisfies the documented-entry rule.
    expect(
      objectEntry(
        '"path":"scripts/cli/cli-options.d.cts","reason":"plain CJS sibling"',
      ).status,
    ).toBe(0);

    // The object's path is what pairs with the declaration, so an object naming
    // a different file leaves the declaration unlisted.
    const mismatched = objectEntry(
      '"path":"scripts/cli/other.d.cts","reason":"plain CJS sibling"',
    );
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.output).toMatch(/scripts\/cli\/cli-options\.d\.cts/);
  });

  it('strips a multi-line block comment without leaking its markers', () => {
    const result = runOnFixture({
      declarations: ['scripts/cli/cli-options.d.cts'],
      knip:
        '{\n  "entry": [\n    /* Hand-written types\n     * for the CLI options.\n     */\n' +
        '    "scripts/cli/cli-options.d.cts"\n  ]\n}\n',
    });

    expect(result.status).toBe(0);
  });
});
