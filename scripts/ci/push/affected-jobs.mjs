/**
 * #1796: which CI jobs a change can affect.
 *
 * `ci.yml` used to run every lane for every change, so a docs-only pull
 * request built and booted a production image. This maps the changed paths to
 * the lanes that can actually break, and the workflow skips a lane only when
 * this answers exactly `false`.
 *
 * Detection fails open. An unresolvable range, an empty change set, or a path
 * no rule claims runs every job, because a fast green that skipped a lane is
 * worse than a slow one. The granularity follows the areas `check:changed`
 * already uses -- `src/contracts/` and `src/catalog/`, `src/modules/<feature>/`,
 * `prisma/migrations/`, `scripts/checks/` -- not individual files.
 *
 * The table below is the whole decision. `coverage` is derived from the three
 * lanes it merges rather than mapped, so it can never run without its inputs.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** @typedef {'static'|'test'|'audit'|'database'|'tenant-isolation'|'coverage'|'build'|'image'} CiJob */
/** @typedef {{area: string, pattern: RegExp, jobs: readonly CiJob[], checks?: readonly string[]}} Area */
/** @typedef {{jobs: Record<CiJob, boolean>, fallback: string | undefined}} JobPlan */

/** Every job this detector can switch off. */
export const CI_JOBS = /** @type {readonly CiJob[]} */ ([
  'static',
  'test',
  'audit',
  'database',
  'tenant-isolation',
  'coverage',
  'build',
  'image',
]);

/**
 * The eight verify-only checks #941 added to the `static` job. A change that
 * can break one of them has to select `static`, which the rows below record.
 */
export const VERIFY_ONLY_CHECKS = /** @type {readonly string[]} */ ([
  'check:data-dictionary',
  'check:file-size',
  'check:domain-globals',
  'check:nginx-headers',
  'check:tenant-global',
  'check:data-ownership',
  'check:app-errors',
  'check:doc-drift',
]);

/**
 * A source change reaches every lane that compiles, tests, or boots `src`.
 */
const SOURCE_JOBS = /** @type {readonly CiJob[]} */ ([
  'static',
  'test',
  'database',
  'tenant-isolation',
  'build',
  'image',
]);

/**
 * Ordered: the first matching row claims the path. A path no row claims is a
 * fail-open, not a silent skip.
 * @type {readonly Area[]}
 */
export const AREAS = [
  {
    // The workflow defines the lanes themselves, so a change to it is checked
    // by running all of them.
    area: 'the CI definition',
    pattern: /^\.github\//,
    jobs: CI_JOBS,
  },
  {
    area: 'this detector',
    pattern: /^scripts\/ci\/push\/affected-jobs/,
    jobs: CI_JOBS,
  },
  {
    // Install, audit, and the image all read the dependency graph.
    area: 'dependency inputs',
    pattern: /^(?:package\.json|bun\.lock)$/,
    jobs: CI_JOBS,
  },
  {
    area: 'the deploy manifest',
    pattern:
      /^(?:Dockerfile|docker-compose(?:\.production)?\.ya?ml|\.env\.production\.example)$|^ops\/[^/]+\.Dockerfile$/,
    jobs: ['static', 'image'],
  },
  {
    area: 'src/contracts and src/catalog',
    pattern: /^src\/(?:contracts|catalog)\//,
    jobs: SOURCE_JOBS,
    checks: ['check:data-ownership', 'check:file-size', 'check:tenant-global'],
  },
  {
    area: 'src/modules',
    pattern: /^src\/modules\//,
    jobs: SOURCE_JOBS,
    checks: [
      'check:app-errors',
      'check:data-ownership',
      'check:file-size',
      'check:tenant-global',
    ],
  },
  {
    area: 'src',
    pattern: /^src\//,
    jobs: SOURCE_JOBS,
    checks: [
      'check:app-errors',
      'check:data-ownership',
      'check:domain-globals',
      'check:file-size',
      'check:tenant-global',
    ],
  },
  {
    area: 'prisma/migrations',
    pattern: /^prisma\/migrations\//,
    jobs: SOURCE_JOBS,
    checks: ['check:data-dictionary'],
  },
  {
    area: 'the Prisma schema and seed',
    pattern: /^prisma\//,
    jobs: SOURCE_JOBS,
    checks: ['check:data-dictionary'],
  },
  {
    // Fixtures and shell specs sit under the same root as the specs.
    area: 'test',
    pattern: /^test\//,
    jobs: ['static', 'test', 'database', 'tenant-isolation'],
    checks: ['check:file-size'],
  },
  {
    area: 'the operator CLI shipped in the image',
    pattern: /^scripts\/cli\//,
    jobs: ['static', 'test', 'image'],
    checks: ['check:file-size'],
  },
  {
    // The checkers under `scripts/checks/` run in `static` and are asserted by
    // the suites the `test` job runs, so both lanes are selected.
    area: 'scripts',
    pattern: /^scripts\//,
    jobs: ['static', 'test'],
    checks: ['check:file-size'],
  },
  {
    area: 'the nginx edge configuration',
    pattern: /^ops\/nginx\//,
    jobs: ['static', 'image'],
    checks: ['check:doc-drift', 'check:nginx-headers'],
  },
  {
    area: 'ops',
    pattern: /^ops\//,
    jobs: ['static', 'image'],
    checks: ['check:doc-drift'],
  },
  {
    area: 'documentation and local agent rules',
    pattern: /^(?:docs\/|AGENTS\.md$|\.claude\/|\.coderabbit\.ya?ml$)|\.md$/,
    jobs: ['static'],
    checks: ['check:doc-drift'],
  },
  {
    area: 'the generated OpenAPI artefacts',
    pattern: /^(?:openapi\.json$|openapi\/)/,
    jobs: ['static'],
  },
];

const FULL_SHA = /^[0-9a-f]{40}$/;
const NULL_SHA = '0000000000000000000000000000000000000000';

/** @returns {Record<CiJob, boolean>} */
function everyJob() {
  /** @type {Record<CiJob, boolean>} */
  const jobs = /** @type {Record<CiJob, boolean>} */ ({});
  for (const job of CI_JOBS) jobs[job] = true;
  return jobs;
}

/** @param {string | undefined} sha */
function usableSha(sha) {
  return typeof sha === 'string' && FULL_SHA.test(sha) && sha !== NULL_SHA
    ? sha
    : undefined;
}

/**
 * The range this trigger asks to diff, or why it has none.
 *
 * @param {{event: string, baseSha?: string | undefined, headSha?: string | undefined}} trigger
 * @returns {{range: string, fallback?: undefined} | {range?: undefined, fallback: string}}
 */
export function diffRange({ event, baseSha, headSha }) {
  if (event === 'workflow_dispatch')
    return { fallback: 'a manual run carries no commit range' };

  const base = usableSha(baseSha);
  const head = usableSha(headSha);
  if (base === undefined || head === undefined)
    return {
      fallback: `the ${event || 'unknown'} trigger carried no usable base`,
    };

  return { range: `${base}..${head}` };
}

/**
 * The jobs a change set can affect. Any path no row claims runs every job.
 *
 * @param {readonly string[]} files
 * @returns {JobPlan}
 */
export function affectedJobs(files) {
  if (files.length === 0)
    return { jobs: everyJob(), fallback: 'no changed files were resolved' };

  /** @type {Set<CiJob>} */
  const selected = new Set();
  for (const file of files) {
    const path = file.replace(/\\/g, '/');
    const area = AREAS.find((candidate) => candidate.pattern.test(path));
    if (area === undefined)
      return { jobs: everyJob(), fallback: `no rule classifies ${path}` };
    for (const job of area.jobs) selected.add(job);
  }

  // `coverage` merges the reports of the three lanes, so it runs only when all
  // three did. Deriving it keeps a row from claiming it on its own.
  if (
    selected.has('test') &&
    selected.has('database') &&
    selected.has('tenant-isolation')
  )
    selected.add('coverage');

  /** @type {Record<CiJob, boolean>} */
  const jobs = /** @type {Record<CiJob, boolean>} */ ({});
  for (const job of CI_JOBS) jobs[job] = selected.has(job);
  return { jobs, fallback: undefined };
}

/**
 * @param {{event: string, baseSha?: string | undefined, headSha?: string | undefined, git: (args: string[]) => string}} input
 * @returns {JobPlan}
 */
export function planCiJobs({ event, baseSha, headSha, git }) {
  const range = diffRange({ event, baseSha, headSha });
  if (range.range === undefined)
    return { jobs: everyJob(), fallback: range.fallback };

  let diff;
  try {
    diff = git(['diff', '--no-renames', '--name-only', range.range]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      jobs: everyJob(),
      fallback: `could not diff ${range.range}: ${message}`,
    };
  }

  const plan = affectedJobs(
    diff
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );

  // The image boot stays the final safety gate before publish, so a push never
  // skips it however narrow the diff looks.
  if (event === 'push') plan.jobs.image = true;
  return plan;
}

/**
 * Emit the plan as GitHub Actions outputs. Every line on stdout becomes an
 * output, so the fallback notice goes to stderr, where the job log shows it.
 */
function main() {
  /** @type {JobPlan} */
  let plan;
  try {
    plan = planCiJobs({
      event: process.env.EVENT ?? '',
      baseSha: process.env.BASE_SHA,
      headSha: process.env.HEAD_SHA,
      git: (args) =>
        execFileSync('git', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
    });
  } catch (error) {
    // Fail open: a detector that cannot answer must not switch lanes off.
    plan = {
      jobs: everyJob(),
      fallback: error instanceof Error ? error.message : String(error),
    };
  }

  if (plan.fallback !== undefined)
    process.stderr.write(
      `affected-jobs: running every job - ${plan.fallback}\n`,
    );

  for (const job of CI_JOBS) process.stdout.write(`${job}=${plan.jobs[job]}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
