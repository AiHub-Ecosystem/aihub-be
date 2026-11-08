import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { BATCHED_GATES, runBatch } =
  /** @type {typeof import('./check-batch.cjs')} */ (
    require('./check-batch.cjs')
  );

/**
 * #813: `bun run check:changed` runs the gates the changed files can break.
 *
 * The full loop costs about 200s and its unit lane alone costs 115s across 327
 * spec files, of which a one-file edit needs a handful. This reads the changed
 * set from git, maps each changed path to the gates it can break, and runs
 * what survives the mapping.
 *
 * Two rules keep the result worth trusting:
 *
 * - It never reports success having decided nothing. An unresolvable git state
 *   or a path no rule classifies runs the full `bun run verify` loop, because a
 *   fast green that is really a skipped gate is worse than a slow one.
 * - Every gate in `bun run verify` has a command here and a tested path mapping,
 *   asserted by `check-changed.spec.mjs`. Adding a gate to `verify` without
 *   classifying it fails that spec, so the map cannot rot into a silent skip.
 */

const TS_GATES = [
  'arch-check',
  'build',
  'check:app-errors',
  'check:data-ownership',
  'check:deprecation',
  'check:file-size',
  'check:imports',
  'check:imports:dist',
  'knip',
  'lint',
  'test:related',
  'type-check',
];

/**
 * #1634: spec and test TypeScript files cannot break the production-only
 * gates, so a test-only diff runs this reduced set. Boundary or contract rules
 * a test path violates are still caught by the full `bun run verify` loop CI
 * runs on push.
 */
const TS_TEST_GATES = ['lint', 'test:related', 'type-check'];

/**
 * Whether a path is test-only: a spec or test file by suffix, or anything
 * under the `test/` root (including fixtures and shell specs).
 * @param {string} path
 */
function isTestPath(path) {
  return (
    path.startsWith('test/') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.test.ts')
  );
}

/**
 * Gate -> the command that runs it. `test:related` uses Bun's changed-file graph.
 */
/** @type {Readonly<Record<string, string>>} */
export const GATE_COMMANDS = {
  'arch-check': 'arch-check',
  build: 'build',
  'coverage:unit': 'coverage:unit',
  'check:data-dictionary': 'check:data-dictionary',
  'check:app-errors': 'check:app-errors',
  'check:deprecation': 'check:deprecation',
  'check:domain-globals': 'check:domain-globals',
  'check:file-size': 'check:file-size',
  'check:imports': 'check:imports',
  'check:imports:dist': 'check:imports:dist',
  'check:migrations': 'check:migrations',
  'check:nginx-headers': 'check:nginx-headers',
  'check:tenant-global': 'check:tenant-global',
  'check:data-ownership': 'check:data-ownership',
  'format:check': 'format:check',
  knip: 'knip',
  lint: 'lint',
  test: 'test',
  'test:capacity-benchmark': 'test:capacity-benchmark',
  'test:check-changed': 'test:check-changed',
  'test:check-app-errors': 'test:check-app-errors',
  'check:doc-drift': 'check:doc-drift',
  'test:doc-drift': 'test:doc-drift',
  'test:issue-triage': 'test:issue-triage',
  'test:jest-specs': 'test:jest-specs',
  'test:lint-staged': 'test:lint-staged',
  'test:monitoring-config': 'test:monitoring-config',
  'test:related': 'test:related',
  'type-check': 'type-check',
  'validate:openapi': 'validate:openapi',
};

/** The one gate that takes the changed spec files as arguments (#1631). */
const JEST_SPECS_GATE = 'test:jest-specs';

/** Independent gates that `check:changed` may run together. */
const BATCHABLE = new Set(BATCHED_GATES);

/** Extensions jest can trace a dependency edge back from. */
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DOC_DRIFT_INPUT = /^(?:docs\/(?:adr|operations)\/|(?:scripts|ops|src)\/)/;

/** @param {string} p */
function norm(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * The gates one changed path can break, or `undefined` when no rule claims it.
 * An unclassified path is not a quiet skip: the caller runs the full loop.
 */
/** @param {string} p @returns {string[] | undefined} */
function classifyPathGates(p) {
  const path = norm(p);
  /** @type {Set<string>} */
  const gates = new Set();

  // #1634: every test path, including non-TypeScript fixtures and shell specs
  // under `test/`, gets the same reduced set. This runs before the tool-specific
  // branches so `check-app-errors.spec.ts` is not mistaken for the tool it tests.
  if (isTestPath(path)) {
    if (path.endsWith('.spec.ts')) gates.add(JEST_SPECS_GATE);
    for (const gate of TS_TEST_GATES) gates.add(gate);
    return sorted(gates);
  }

  if (path === 'openapi.json') {
    return ['lint', 'validate:openapi'];
  }

  if (/(^|\/)jest\.config[^/]*\.(?:cjs|js|ts)$/.test(path)) {
    return ['coverage:unit', 'lint'];
  }

  if (path.includes('check-app-errors')) {
    return ['check:app-errors', 'lint', 'test:check-app-errors'];
  }

  // Contract schemas also define the published surface, so a change there needs
  // the OpenAPI assertion on top of the gate set every source file gets. This
  // adds to that set rather than claiming the path on its own: a contract that
  // stops compiling, or that breaks the spec importing it, is not an OpenAPI
  // problem and `validate:openapi` would report it green.
  if (path.endsWith('.ts')) {
    for (const gate of TS_GATES) gates.add(gate);
    if (/(^|\/)domain\//.test(path)) gates.add('check:domain-globals');
    gates.add('check:tenant-global');
    if (/(^|\/)src\/contracts\//.test(path)) gates.add('validate:openapi');
    return sorted(gates);
  }

  // A schema change regenerates the client, so every spec that touches the
  // database can break: the related-spec narrowing does not apply here.
  if (
    /(^|\/)prisma(\/|$)/.test(path) ||
    path.endsWith('.prisma') ||
    path.endsWith('.sql') ||
    /migration/i.test(path)
  ) {
    return [
      'build',
      'check:data-dictionary',
      'check:imports:dist',
      'check:migrations',
      'knip',
      'lint',
      'test',
      'type-check',
    ];
  }

  if (/\.(?:md|ya?ml)$/.test(path)) {
    return ['format:check'];
  }

  if (/(^|\/)scripts\/ops\/capacity-benchmark\//.test(path)) {
    return ['lint', 'test:capacity-benchmark'];
  }

  if (/(^|\/)scripts\/ops\/monitoring\/check-monitoring-config\./.test(path)) {
    return ['lint', 'test:monitoring-config'];
  }

  if (path.includes('check-changed')) {
    return ['lint', 'test:check-changed'];
  }
  if (path.includes('run-bun-test')) {
    return ['lint', 'test:check-changed'];
  }
  if (path.includes('issue-triage')) {
    return ['lint', 'test:issue-triage'];
  }
  if (path.includes('check-doc-drift')) {
    return ['check:doc-drift', 'lint', 'test:doc-drift'];
  }
  if (path.includes('lint-staged-config')) {
    return ['lint', 'test:lint-staged'];
  }

  if (path.includes('nginx')) {
    return ['check:nginx-headers', 'lint'];
  }

  if (CODE_FILE.test(path)) {
    return ['lint', 'test:related'];
  }

  return undefined;
}

/**
 * The documentation drift gate also reads ADRs and operations runbooks and
 * checks paths they reference, so changes or removals under those source roots
 * must select it alongside their other gates.
 * @param {string} p
 * @returns {string[] | undefined}
 */
export function classifyPath(p) {
  const path = norm(p);
  const gates = classifyPathGates(path);
  if (
    gates === undefined ||
    !DOC_DRIFT_INPUT.test(path) ||
    gates.includes('check:doc-drift')
  ) {
    return gates;
  }
  return sorted(new Set([...gates, 'check:doc-drift']));
}

/** @param {Set<string>} gates @returns {string[]} */
function sorted(gates) {
  return [...gates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {readonly string[]} files
 * @returns {{ gates: string[], fullVerify?: false, reason?: never } | { gates?: never, fullVerify: true, reason: string }}
 */
export function planChangedFiles(files) {
  if (files.length === 0) {
    return { fullVerify: true, reason: 'no changed files resolved' };
  }

  /** @type {Set<string>} */
  const gates = new Set();
  for (const file of files) {
    const matched = classifyPath(file);
    if (matched === undefined) {
      return { fullVerify: true, reason: `unclassified path: ${file}` };
    }
    for (const gate of matched) gates.add(gate);
  }

  return { gates: sorted(gates) };
}

/**
 * The package script and arguments one gate runs. The Jest gate gets the
 * changed `*.spec.ts` files that still exist: Jest itself decides which of them
 * `jest.config.cjs` matches or ignores, so this list is not a second copy of
 * that policy. `undefined` means the gate has nothing to run, because every
 * changed spec was deleted.
 * ponytail: the list travels on the command line; a change touching hundreds of
 * specs can exceed the Windows limit and then fails loudly, not silently.
 *
 * @param {string} gate
 * @param {readonly string[]} files
 * @param {(path: string) => boolean} [exists]
 * @returns {{ script: string, args: string[] } | undefined}
 */
export function gateInvocation(gate, files, exists = existsSync) {
  const script = GATE_COMMANDS[gate];
  if (gate !== JEST_SPECS_GATE) return { script, args: [] };

  const specs = files
    .map(norm)
    .filter((file) => file.endsWith('.spec.ts') && exists(file));
  return specs.length === 0
    ? undefined
    : { script, args: sorted(new Set(specs)) };
}

/** @param {string[]} args @returns {string} */
function defaultGit(args) {
  // execFileSync, not a shell string: a path or ref is an argument, never
  // something to be re-parsed.
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The union of what the branch changed and what the working tree has not
 * committed yet. Uncommitted work is the common case and the reason this tool
 * exists: a diff that read only commits would report nothing and pass.
 */
/** @param {(args: string[]) => string} [git] @returns {string[]} */
export function resolveChangedFiles(git = defaultGit) {
  const mergeBase = git(['merge-base', 'HEAD', 'origin/main']);
  const chunks = [
    git(['diff', '--no-renames', '--name-only', mergeBase, 'HEAD']),
    git(['diff', '--no-renames', '--name-only']),
    git(['diff', '--no-renames', '--cached', '--name-only']),
    git(['ls-files', '--others', '--exclude-standard']),
  ];

  /** @type {Set<string>} */
  const files = new Set();
  for (const chunk of chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) files.add(line.trim());
    }
  }
  return [...files];
}

/**
 * @param {{resolveFiles: () => string[], runGate: (gate: string) => number | Promise<number>, runBatchGates: (gates: string[]) => Promise<{failed: string[]}>, runFullVerify: () => unknown}} options
 * @returns {Promise<string>} `full-verify` when it deferred to the whole loop,
 *   `passed` when every selected gate passed, otherwise the gate that failed.
 */
export async function runCheckChanged({
  resolveFiles,
  runGate,
  runBatchGates,
  runFullVerify,
}) {
  /** @type {string[]} */
  let files;
  try {
    files = resolveFiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    console.error(
      '[check:changed] could not resolve the changed set:',
      message,
    );
    runFullVerify();
    return 'full-verify';
  }

  const plan = planChangedFiles(files);
  if (plan.fullVerify) {
    console.error(`[check:changed] ${plan.reason}; running the full loop.`);
    runFullVerify();
    return 'full-verify';
  }

  const batch = plan.gates.filter((gate) => BATCHABLE.has(gate));
  if (batch.length > 1) {
    const { failed } = await runBatchGates(batch);
    if (failed.length > 0) {
      const first = failed[0];
      console.error(`[check:changed] gate failed: ${first}`);
      return first;
    }
  }

  for (const gate of plan.gates) {
    if (batch.length > 1 && BATCHABLE.has(gate)) continue;
    const status = await runGate(gate);
    if (status !== 0) {
      console.error(`[check:changed] gate failed: ${gate}`);
      return gate;
    }
  }

  return 'passed';
}

/**
 * Run a package script. `bun` is a real executable on every platform, so no
 * shell is involved and the changed-file arguments need no quoting.
 */
/** @param {string} script @param {string[]} args @returns {number} */
function runScript(script, args) {
  const result = spawnSync('bun', ['run', script, ...args], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/** @param {string} gate @param {string[]} files @returns {Promise<{code: number, output: string}>} */
async function runBufferedGate(gate, files) {
  const invocation = gateInvocation(gate, files);
  if (!invocation) {
    return {
      code: 0,
      output: `[check:changed] skip ${gate}: no changed spec file exists\n`,
    };
  }
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', invocation.script, ...invocation.args], {
      cwd: process.cwd(),
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) =>
      resolve({ code: 1, output: `${gate}: ${error.message}\n` }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  /** @type {string[]} */
  let files = [];
  let fullVerifyStatus = 1;

  const outcome = await runCheckChanged({
    resolveFiles: () => {
      files = resolveChangedFiles();
      return files;
    },
    runGate: (gate) => {
      const invocation = gateInvocation(gate, files);
      if (!invocation) {
        console.log(
          `[check:changed] skip ${gate}: no changed spec file exists`,
        );
        return 0;
      }
      console.log(
        `[check:changed] bun run ${[invocation.script, ...invocation.args].join(' ')}`,
      );
      return runScript(invocation.script, invocation.args);
    },
    runBatchGates: async (gates) => {
      const result = await runBatch({
        gates,
        run: async (gate) => runBufferedGate(gate, files),
        log: (line) => console.log(line),
        error: (line) => console.error(line),
      });
      return { failed: result.failed };
    },
    runFullVerify: () => {
      fullVerifyStatus = runScript('verify', []);
    },
  });

  if (outcome === 'full-verify') {
    console.log(
      fullVerifyStatus === 0
        ? '[check:changed] PASS (full verify ran; no separate bun run verify needed)'
        : '[check:changed] FAIL (full verify)',
    );
    return fullVerifyStatus;
  }
  if (outcome === 'passed') {
    console.log('[check:changed] PASS');
    return 0;
  }
  return 1;
}

/**
 * Whether this module is the script the process was started with.
 *
 * Comparing `import.meta.url` against a hand-built `file://${argv[1]}` string
 * looks right and is wrong on Windows, where `argv[1]` carries backslashes:
 * the comparison never matches, `main` never runs, and the script exits 0
 * having run no gate at all. `pathToFileURL` is the only spelling both
 * platforms agree on.
 */
/** @param {string} moduleUrl @param {string | undefined} argv1 @returns {boolean} */
export function isEntryPoint(moduleUrl, argv1) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().then(
    (status) => process.exit(status),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
