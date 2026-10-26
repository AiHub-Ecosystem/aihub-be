import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * #813: `pnpm check:changed` runs the gates the changed files can break.
 *
 * The full loop costs about 200s and its unit lane alone costs 115s across 327
 * spec files, of which a one-file edit needs a handful. This reads the changed
 * set from git, maps each changed path to the gates it can break, and runs
 * what survives the mapping.
 *
 * Two rules keep the result worth trusting:
 *
 * - It never reports success having decided nothing. An unresolvable git state
 *   or a path no rule classifies runs the full `pnpm verify` loop, because a
 *   fast green that is really a skipped gate is worse than a slow one.
 * - Every gate in `pnpm verify` has a command here and a tested path mapping,
 *   asserted by `check-changed.spec.mjs`. Adding a gate to `verify` without
 *   classifying it fails that spec, so the map cannot rot into a silent skip.
 */

const TS_GATES = [
  'arch-check',
  'build',
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

/** Gate -> the command that runs it. `test:related` reads the changed files. */
/** @type {Readonly<Record<string, string>>} */
export const GATE_COMMANDS = {
  'arch-check': 'arch-check',
  build: 'build',
  'check:data-dictionary': 'check:data-dictionary',
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
  'check:doc-drift': 'check:doc-drift',
  'test:doc-drift': 'test:doc-drift',
  'test:issue-triage': 'test:issue-triage',
  'test:monitoring-config': 'test:monitoring-config',
  'test:related': 'test:related',
  'type-check': 'type-check',
  'validate:openapi': 'validate:openapi',
};

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

  if (path === 'openapi.json') {
    return ['lint', 'validate:openapi'];
  }

  if (/(^|\/)jest\.config[^/]*\.(?:cjs|js|ts)$/.test(path)) {
    return ['lint', 'test'];
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
  if (path.includes('issue-triage')) {
    return ['lint', 'test:issue-triage'];
  }
  if (path.includes('check-doc-drift')) {
    return ['check:doc-drift', 'lint', 'test:doc-drift'];
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
 * @returns {string} `full-verify` when it deferred to the whole loop, `passed`
 *   when every selected gate passed, otherwise the gate that failed.
 */
/**
 * @param {{resolveFiles: () => string[], runGate: (gate: string) => number, runFullVerify: () => unknown}} options
 * @returns {string}
 */
export function runCheckChanged({ resolveFiles, runGate, runFullVerify }) {
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

  for (const gate of plan.gates) {
    const status = runGate(gate);
    if (status !== 0) {
      console.error(`[check:changed] gate failed: ${gate}`);
      return gate;
    }
  }

  return 'passed';
}

/**
 * Run a package script.
 *
 * Windows needs `shell: true`: Node refuses to spawn a `.cmd` without it
 * (`EINVAL`), and a failed spawn is indistinguishable from a failed gate unless
 * the status is checked. Going through a shell means the arguments are no
 * longer escaped for us, and the changed-file arguments can hold a space, so
 * they are quoted here rather than assumed.
 */
/** @param {string} script @param {string[]} args @returns {number} */
function runPnpm(script, args) {
  const windows = process.platform === 'win32';
  const quote = (/** @type {string} */ arg) =>
    /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
  const result = spawnSync(
    windows ? 'pnpm.cmd' : 'pnpm',
    [script, ...args].map((arg) => (windows ? quote(arg) : arg)),
    {
      stdio: 'inherit',
      shell: windows,
    },
  );
  return result.status ?? 1;
}

function main() {
  /** @type {string[]} */
  let files = [];
  let fullVerifyStatus = 1;

  const outcome = runCheckChanged({
    resolveFiles: () => {
      files = resolveChangedFiles();
      return files;
    },
    runGate: (gate) => {
      const script = GATE_COMMANDS[gate];
      const args =
        gate === 'test:related'
          ? files.filter((file) => CODE_FILE.test(file))
          : [];
      console.log(
        `[check:changed] pnpm ${script}${args.length ? ` (${args.length} file(s))` : ''}`,
      );
      return runPnpm(script, args);
    },
    runFullVerify: () => {
      fullVerifyStatus = runPnpm('verify', []);
    },
  });

  if (outcome === 'full-verify') return fullVerifyStatus;
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
  process.exit(main());
}
