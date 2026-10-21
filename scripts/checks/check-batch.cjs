'use strict';
/**
 * Runs the gates that touch nothing but the repository side by side, so
 * `pnpm verify` pays one process start where it used to pay eleven.
 *
 * Measured 2026-10-21 on a 12-core developer machine: each member costs
 * 1,1-2,6 s sequentially, and a gate whose real work is a repo-wide scan still
 * takes 1,1 s, which is essentially pnpm plus Node starting up. The set is
 * 20,6 s run one after another.
 *
 * The ceiling is derived from free memory and never exceeds three because every
 * member is its own Node process: the batch trades wall clock for resident
 * memory on exactly the machines this loop already struggles on. It never runs
 * zero children, so a machine reporting nothing usable still finishes.
 *
 * Output is buffered per member and printed in declared order, never
 * interleaved. A failure is reported under a single `$ pnpm <gate>` marker for
 * the first gate that failed, because that is the line `verify:summary` scans
 * backwards from `ELIFECYCLE` to name the failing step; without the marker the
 * summary would blame this batch instead of the gate inside it.
 */

const { spawn } = require('node:child_process');
const os = require('node:os');

const BYTES_PER_CHILD = 256 * 1024 * 1024;
const MAX_CONCURRENCY = 3;

/**
 * Gates with no output, artifact, or ordering dependency on each other.
 * `check:nginx-headers` is excluded deliberately: it needs nginx installed and
 * is not portable to every developer machine.
 */
const BATCHED_GATES = [
  'check:imports',
  'check:migrations',
  'check:data-dictionary',
  'check:file-size',
  'check:domain-globals',
  'check:deprecation',
  'check:tenant-global',
  'check:data-ownership',
  'validate:openapi',
  'test:capacity-benchmark',
  'test:check-changed',
  'test:issue-triage',
];

function concurrencyFor({ freeBytes } = {}) {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return 1;
  return Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(freeBytes / BYTES_PER_CHILD)),
  );
}

/** A gate name is a declared script name, never free text. */
const GATE_NAME = /^[A-Za-z0-9:_-]+$/;

function runGate(gate) {
  if (!GATE_NAME.test(gate)) {
    return Promise.resolve({
      code: 1,
      output: `${gate}: refused, not a gate name\n`,
    });
  }
  return new Promise((resolve) => {
    // One command string and no argument array: pnpm is a .cmd on Windows, which
    // Node refuses to spawn without a shell, and passing args alongside a shell is
    // the unescaped-argument hazard (DEP0190) this shape avoids. What reaches the
    // shell is a name checked above and taken from BATCHED_GATES or the caller.
    const child = spawn(`pnpm run ${gate}`, {
      cwd: process.cwd(),
      shell: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) =>
      resolve({ code: 1, output: `${gate}: ${error.message}\n` }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function runBatch({
  gates = BATCHED_GATES,
  freeBytes = os.freemem(),
  run = runGate,
  log = (...args) => console.log(...args),
  error = (...args) => console.error(...args),
} = {}) {
  const concurrency = concurrencyFor({ freeBytes });
  const completed = [];
  let next = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  // A pool of workers pulling from one shared cursor, so the ceiling holds
  // whether a gate is slow or the machine is fast.
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= gates.length) return;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const result = await run(gates[index]);
        completed.push({
          index,
          gate: gates[index],
          code: result?.code ?? 1,
          output: result?.output ?? '',
        });
      } catch (cause) {
        completed.push({
          index,
          gate: gates[index],
          code: 1,
          output: `${gates[index]}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        });
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, gates.length) }, () => worker()),
  );

  const finished = completed.sort((left, right) => left.index - right.index);
  const failures = finished.filter((result) => result.code !== 0);

  if (failures.length === 0) {
    for (const result of finished) log(`check:batch: ${result.gate} ok`);
    log(
      `check:batch: ${finished.length} gates passed, ${concurrency} concurrent`,
    );
    return { exitCode: 0, concurrency, peakInFlight, failed: [] };
  }

  // One marker only, and it names the first gate that failed in declared order.
  const [first, ...rest] = failures;
  error(`$ pnpm ${first.gate}`);
  for (const line of first.output.replace(/\r?\n$/, '').split(/\r?\n/))
    error(line);
  for (const failure of rest) error(`check:batch: also failed ${failure.gate}`);
  error(`check:batch: ${failures.length} of ${finished.length} gates failed`);

  return {
    exitCode: 1,
    concurrency,
    peakInFlight,
    failed: failures.map((failure) => failure.gate),
  };
}

if (require.main === module) {
  const main = async () => {
    process.exitCode = (await runBatch()).exitCode;
  };
  void main();
}

module.exports = {
  BATCHED_GATES,
  MAX_CONCURRENCY,
  BYTES_PER_CHILD,
  concurrencyFor,
  runBatch,
};
