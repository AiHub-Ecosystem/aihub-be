/**
 * Which commits the CI `secret-scan` job scans, decided from the trigger.
 *
 * #1779: the job used to fall through to a full-history scan whenever it could
 * not resolve a push range, and a `workflow_dispatch` run never has one. So a
 * manual run on one commit silently became a scan of every commit ever made,
 * and reported their findings as that run's result.
 *
 * The decision lives here, not inline in the workflow, so the spec can assert
 * it without running GitHub Actions.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{event: string, baseSha?: string | undefined, headSha?: string | undefined}} ScanTrigger
 * @typedef {{mode: 'range', range: string} | {mode: 'full-history'} | {mode: 'refused', message: string}} ScanPlan
 */

const FULL_SHA = /^[0-9a-f]{40}$/;
const NULL_SHA = '0000000000000000000000000000000000000000';

/**
 * The scan a trigger asks for.
 *
 * A push or pull request that carries a usable range scans exactly that range.
 * A full-history scan is only ever requested deliberately, never as a fallback:
 * a manual run has no range of its own, so it is refused with a message that
 * names the way to scan a range instead.
 *
 * @param {ScanTrigger} trigger
 * @returns {ScanPlan}
 */
export function planSecretScan(trigger) {
  const { event, baseSha, headSha } = trigger;

  if (event === 'workflow_dispatch') {
    return {
      mode: 'refused',
      message:
        'secret-scan does not run on workflow_dispatch: a manual run has no ' +
        'commit range, and scanning the whole history would report unrelated ' +
        'findings as this run\u2019s result. Push a commit or open a pull ' +
        'request to scan a range.',
    };
  }

  const baseUsable =
    typeof baseSha === 'string' &&
    FULL_SHA.test(baseSha) &&
    baseSha !== NULL_SHA;
  const headUsable = typeof headSha === 'string' && FULL_SHA.test(headSha);

  if (baseUsable && headUsable && baseSha !== headSha) {
    return { mode: 'range', range: `${baseSha}..${headSha}` };
  }

  // A push that starts a ref (or a force-push whose old tip is unknown)
  // carries no usable base. Scanning everything is the only honest answer left,
  // and it is a deliberate choice here rather than an unguarded `else`.
  return { mode: 'full-history' };
}

/**
 * Print the plan for the trigger in the environment, so the workflow can apply
 * the same decision the spec asserts. Kept beside the pure function so the two
 * cannot drift.
 */
function main() {
  const plan = planSecretScan({
    event: process.env.EVENT ?? '',
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
