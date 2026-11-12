import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

/**
 * #1777: `format:check` runs with prettier's content-addressed cache, because
 * an uncached run re-processes every Markdown and YAML file in the tree on
 * local `verify` and `check:changed` invocations. CI runs the gate but does
 * not restore a persistent Prettier cache.
 *
 * The cache is only worth adopting if it cannot hide a real finding, so these
 * tests assert the flags and then prove the gate still fails on a mis-formatted
 * file with a warm cache.
 */

/** @returns {{format: string, formatCheck: string}} */
function readFormatScripts() {
  const manifest = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  return {
    format: manifest.scripts.format ?? '',
    formatCheck: manifest.scripts['format:check'] ?? '',
  };
}

await test('format:check runs prettier with the content-addressed cache (#1777)', () => {
  const { formatCheck } = readFormatScripts();
  assert.match(
    formatCheck,
    /prettier\b/,
    'format:check must still be the prettier gate',
  );
  assert.match(
    formatCheck,
    /--cache\b/,
    'format:check must pass --cache or it re-pays the full tree on every run',
  );
});

await test('the cache stays inside node_modules so it cannot leak into a build gate (#1777)', () => {
  const { formatCheck } = readFormatScripts();
  // Prettier's default cache location is node_modules/.cache/prettier. An
  // explicit --cache-location must stay under node_modules, which .gitignore
  // already excludes and which no dist gate scans.
  const explicit = formatCheck.match(/--cache-location[=\s]+(\S+)/);
  if (explicit) {
    const location = explicit[1].replace(/^["']|["']$/g, '');
    assert.ok(
      location.includes('node_modules'),
      `--cache-location ${location} must stay under node_modules`,
    );
  }
  assert.doesNotMatch(
    formatCheck,
    /--cache-location[=\s]+["']?(?!.*node_modules)/,
    'a cache location outside node_modules would escape .gitignore',
  );
});

await test('CI runs the formatting gate (#1813)', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /bun run format:check/);
});
/** @param {import('node:test').TestContext} t @returns {Promise<string>} */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aihub-format-cache-'));
  assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Run prettier the way `format:check` does, against a fixture tree.
 * @param {string} cwd
 * @returns {{status: number | null, stdout: string}}
 */
function runPrettierCheck(cwd) {
  const result = spawnSync(
    'node',
    [
      resolve('node_modules', 'prettier', 'bin', 'prettier.cjs'),
      '--check',
      '--cache',
      '--cache-location',
      join(cwd, 'node_modules', '.cache', 'prettier'),
      '**/*.{md,yaml,yml}',
    ],
    { cwd, encoding: 'utf8' },
  );
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

await test('a mis-formatted file still fails the cached check (#1777)', async (t) => {
  const root = await fixture(t);
  const config = resolve('.prettierrc');
  await writeFile(
    join(root, '.prettierrc'),
    await readFile(config, 'utf8'),
    'utf8',
  );

  const good = join(root, 'guide.md');
  await writeFile(good, '# Guide\n\nWell formatted.\n', 'utf8');

  // Prime the cache with a passing run, so the failing run below is the
  // first time the file's content is wrong with a warm cache.
  const primed = runPrettierCheck(root);
  assert.equal(
    primed.status,
    0,
    `the clean tree must pass before the cache is primed: ${primed.stdout}`,
  );

  const cachedPass = runPrettierCheck(root);
  assert.equal(
    cachedPass.status,
    0,
    'the second run reads the cache and must still pass',
  );

  // Rewrite the file with bad formatting. A content-addressed cache keys on
  // content, so this must be re-checked rather than trusted.
  await writeFile(good, '# Guide\n\n\n\n   badly   formatted\n', 'utf8');
  const failed = runPrettierCheck(root);
  assert.notEqual(
    failed.status,
    0,
    'a mis-formatted file must fail even with a warm cache',
  );
});
