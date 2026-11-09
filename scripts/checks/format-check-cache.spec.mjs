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
 * every `verify` and `check:changed` invocation.
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

await test('CI caches prettier so the cached gate is not cold on every run (#1777)', () => {
  // Asserted against the workflow text rather than a parsed tree: no YAML
  // parser is a declared dependency here, and importing one would lean on a
  // hoisted transitive package that knip rightly flags.
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  const formatIndex = workflow.indexOf('bun run format:check');
  assert.ok(formatIndex >= 0, 'a CI job must still run `bun run format:check`');

  const cacheIndex = workflow.indexOf('node_modules/.cache/prettier');
  assert.ok(
    cacheIndex >= 0,
    'CI must cache node_modules/.cache/prettier, or format:check pays the cold cache on every run',
  );

  // Restoring after a run would save a cache that is never read again.
  assert.ok(
    cacheIndex < formatIndex,
    'the prettier cache must be restored before the formatting check runs',
  );

  // The path must sit inside a real actions/cache step, not a stray mention.
  const cacheStepStart = workflow.lastIndexOf(
    'uses: actions/cache@',
    cacheIndex,
  );
  assert.ok(
    cacheStepStart >= 0 && cacheIndex - cacheStepStart < 500,
    'the prettier cache path must belong to an actions/cache step',
  );

  // A key that omits the config or the lockfile keeps serving entries written
  // under options the gate no longer uses. The key step is written after the
  // path line, so the window runs from the cache step to the next `- name:`
  // step rather than stopping at the path.
  const stepEnd = workflow.indexOf('\n      - name:', cacheIndex);
  const keyLine = workflow
    .slice(cacheStepStart, stepEnd === -1 ? undefined : stepEnd)
    .split('\n')
    .find((line) => line.trim().startsWith('key:'));
  assert.ok(keyLine, 'the prettier cache step must declare a key');
  for (const input of ['bun.lock', '.prettierrc', '.prettierignore']) {
    assert.ok(
      keyLine.includes(input),
      `the cache key must include ${input} so an option change invalidates the cache`,
    );
  }
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
