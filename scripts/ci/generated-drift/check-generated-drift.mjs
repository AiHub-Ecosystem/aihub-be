import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * #1789: CI regenerates the contract artifacts but never asserted the
 * committed files match, so a stale `openapi.json`, a stale `openapi/v*.json`,
 * an out-of-sync Postman collection, or an out-of-sync email template could
 * pass and ship. Every generator here writes deterministically - no
 * timestamps - so regeneration is idempotent on a clean tree, and the only
 * missing piece is the clean-tree assertion this check performs.
 *
 * The check lives in CI's `static` job, which is required on pull requests
 * and pushes to main through the `ci` summary job. It deliberately never runs
 * inside the local `check:batch` / `verify` loop: regenerating rewrites the
 * artifact files, and a local run over a developer's uncommitted work could
 * clobber exactly the changes it should be protecting. A clean CI checkout is
 * the only honest place for it.
 */

/**
 * Each generated artifact: the command that regenerates it and the paths it
 * owns. A path may be a file or a directory; `git status --porcelain` covers
 * both, including a file the generator stopped writing (which `git diff`
 * alone would silently forgive).
 * @typedef {{name: string, command: [string, string[]], paths: string[]}} GeneratedArtifact
 * @type {readonly GeneratedArtifact[]}
 */
export const GENERATED_ARTIFACTS = [
  {
    name: 'OpenAPI document and majors',
    command: ['bun', ['run', 'generate:openapi']],
    paths: ['openapi.json', 'openapi'],
  },
  {
    name: 'Postman collection',
    command: ['bun', ['run', 'generate:postman']],
    paths: ['aihub.postman_collection.json'],
  },
  {
    name: 'Transactional email template',
    command: ['node', ['scripts/generate/compile-auth-email-template.mjs']],
    paths: [
      'src/modules/auth/email-delivery/application/templates/transactional-email.template.generated.ts',
    ],
  },
];

/**
 * Regenerates every artifact in order and reports the drift.
 *
 * A generator that exits non-zero is reported as a failed generator rather
 * than silently passing its artifact: a broken regeneration must not read as
 * "no drift". Regeneration stops being checked for that artifact only; the
 * remaining artifacts are still checked, so one broken generator does not
 * hide the others' drift.
 *
 * @param {{ run: (file: string, args: string[]) => {code: number}, status: (paths: string[]) => string[] }} io
 *   `run` regenerates one artifact; `status` answers with the dirty entries
 *   for the given paths, in `git status --porcelain` line form.
 * @returns {{ drifted: string[], failedGenerators: string[] }}
 */
export function findGeneratedDrift(io) {
  /** @type {string[]} */
  const drifted = [];
  /** @type {string[]} */
  const failedGenerators = [];
  for (const artifact of GENERATED_ARTIFACTS) {
    const [file, args] = artifact.command;
    if (io.run(file, args).code !== 0) {
      failedGenerators.push(artifact.name);
      continue;
    }
    const dirty = io.status(artifact.paths);
    if (dirty.length > 0) {
      drifted.push(`${artifact.name}: ${dirty.join(', ')}`);
    }
  }
  return { drifted, failedGenerators };
}

function main() {
  const { drifted, failedGenerators } = findGeneratedDrift({
    // spawnSync answers with `status`, not `code`; a spawn error (a missing
    // executable) leaves `status` null and counts as a failure too.
    run: (file, args) => {
      const result = spawnSync(file, args, { stdio: 'inherit' });
      return { code: result.status ?? 1 };
    },
    status: (paths) => {
      const result = spawnSync(
        'git',
        ['status', '--porcelain', '--', ...paths],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      return (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim());
    },
  });

  for (const generator of failedGenerators) {
    console.error(
      `Generated artifact check failed: the ${generator} generator exited non-zero`,
    );
  }
  for (const entry of drifted) {
    console.error(
      `Generated artifact check failed: ${entry} differs from the committed output; run its generator and commit the result`,
    );
  }
  process.exit(failedGenerators.length + drifted.length > 0 ? 1 : 0);
}

if (
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
