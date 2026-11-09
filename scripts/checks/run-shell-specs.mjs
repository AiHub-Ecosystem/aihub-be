import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Runs the co-located shell suites `check:changed` selected for changed
 * wrappers under `scripts/ops/` (#1460). The arguments are the `*.spec.sh`
 * paths `gateInvocation` computed; each runs with bash exactly as the CI
 * "Exercise ... with stubs" steps do. Every selected suite runs even after a
 * failure, and any failure fails the gate.
 */
const specs = process.argv.slice(2);
if (specs.length === 0 || specs.some((spec) => !spec.endsWith('.spec.sh'))) {
  console.error(
    'usage: node scripts/checks/run-shell-specs.mjs <path/to/suite.spec.sh>...',
  );
  process.exit(1);
}

let failed = false;
for (const spec of specs) {
  console.log(`$ bash ${spec}`);
  const result = spawnSync('bash', [spec], { stdio: 'inherit' });
  if ((result.status ?? 1) !== 0) {
    console.error(`run-shell-specs: ${spec} failed`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
