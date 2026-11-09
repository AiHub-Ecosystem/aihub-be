import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * #1786: the commit-message gate lives only at hook time. A
 * `git commit --no-verify` — which the maintainers already use when a mixed
 * staged set blocks the hook — lands a non-Conventional header, and no CI job
 * checked the range. This check lints exactly the commits a trigger changes:
 * the pull request's range, or the push range on main. A range-less trigger
 * (a manual run, a push that starts the branch) is skipped with a reason
 * rather than falling back to a full-history lint, which would report every
 * historical violation as this run's result.
 *
 * Each message is linted by invoking the hook script itself, so CI exercises
 * the exact gate a developer's commit-msg hook runs, not a copy of it.
 */

export const NULL_SHA = '0000000000000000000000000000000000000000';
const FULL_SHA = /^[0-9a-f]{40}$/;

/** @typedef {{event: string, baseSha?: string | undefined, headSha?: string | undefined}} RangeTrigger */
/** @typedef {{mode: 'range', base: string, head: string} | {mode: 'skipped', message: string}} CommitRangePlan */

/**
 * The range a trigger asks this check to lint.
 * @param {RangeTrigger} trigger
 * @returns {CommitRangePlan}
 */
export function planCommitMessageRange(trigger) {
  const { event, baseSha, headSha } = trigger;

  if (event === 'workflow_dispatch') {
    return {
      mode: 'skipped',
      message:
        'commit-message check does not run on workflow_dispatch: a manual run has no commit range',
    };
  }

  const usable = (/** @type {string | undefined} */ sha) =>
    typeof sha === 'string' && FULL_SHA.test(sha) && sha !== NULL_SHA;

  if (usable(baseSha) && usable(headSha) && baseSha !== headSha) {
    return {
      mode: 'range',
      base: /** @type {string} */ (baseSha),
      head: /** @type {string} */ (headSha),
    };
  }

  return {
    mode: 'skipped',
    message:
      'commit-message check found no usable range: a push that starts the branch carries no base, and the hook already gated those commits locally',
  };
}

/**
 * Lints every commit in the planned range through the hook script.
 *
 * @param {{ plan: CommitRangePlan, listCommits: (base: string, head: string) => string[], lintCommit: (sha: string) => string[] }} io
 *   `listCommits` answers with the shas in the range; `lintCommit` runs one
 *   message through the hook and answers with its problems, empty when the
 *   message passes.
 * @returns {{ checked: number, failures: string[] }}
 */
export function lintCommitRange(io) {
  if (io.plan.mode === 'skipped') {
    return { checked: 0, failures: [] };
  }
  const commits = io.listCommits(io.plan.base, io.plan.head);
  /** @type {string[]} */
  const failures = [];
  for (const sha of commits) {
    const problems = io.lintCommit(sha);
    for (const problem of problems) {
      failures.push(`${sha}: ${problem}`);
    }
  }
  return { checked: commits.length, failures };
}

/** @param {string} base @param {string} head @returns {string[]} */
function listCommits(base, head) {
  const result = spawnSync('git', ['rev-list', `${base}..${head}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    console.error(`commit-message check could not list ${base}..${head}`);
    process.exit(1);
  }
  return (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim());
}

/**
 * Runs one commit's message through the real hook script.
 * @param {string} sha @param {string} directory @returns {string[]}
 */
function lintCommit(sha, directory) {
  const file = join(directory, 'commit-message.txt');
  const shown = spawnSync('git', ['show', '-s', '--format=%B', sha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (shown.status !== 0) {
    return ['the commit message could not be read with git show'];
  }
  writeFileSync(file, shown.stdout ?? '');
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/checks/hooks/commit-message.mjs', file],
      { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
    );
    if (result.status === 0) return [];
    const output = /** @type {string} */ (result.stderr ?? '');
    return output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('  - '))
      .map((line) => line.replace(/^ {2}- /, ''));
  } finally {
    rmSync(file, { force: true });
  }
}

function main() {
  const plan = planCommitMessageRange({
    event: process.env.COMMIT_EVENT ?? '',
    baseSha: process.env.COMMIT_BASE,
    headSha: process.env.COMMIT_HEAD,
  });
  if (plan.mode === 'skipped') {
    console.log(`commit-message check skipped: ${plan.message}`);
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'aihub-commit-message-'));
  try {
    const { checked, failures } = lintCommitRange({
      plan,
      listCommits,
      lintCommit: (sha) => lintCommit(sha, directory),
    });
    for (const failure of failures) {
      console.error(`Commit message check failed: ${failure}`);
    }
    if (failures.length > 0) {
      console.error(
        `\n${failures.length} of ${checked} commit message(s) rejected; every commit header must be "type(scope): subject"`,
      );
      process.exit(1);
    }
    console.log(`commit-message check: ${checked} commit message(s) passed`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
