'use strict';

/**
 * `bun run verify:summary`: the same loop as `bun run verify`, reported in a few
 * lines. The full output goes to a log file of its own, so reading the result
 * costs a handful of lines instead of the 20 to 60 KB the loop prints, and two
 * runs can never write into one file.
 *
 * Plain CommonJS so the spec can import `summarize` and `logFileName`, as with
 * the other scripts a test needs to reach.
 */

const childProcess = /** @type {typeof import('node:child_process')} */ (
  require('node:child_process')
);
const { spawn } = childProcess;
const { mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g');
const MAX_STEP_LINES = 25;
const MAX_JEST_FILES = 10;
const MAX_JEST_TESTS = 8;
const MAX_TAIL_LINES = 6;
// Node's V8 abort (exit 134 on POSIX, 3221226505 on Windows) and the message it
// prints before it.
const OUT_OF_MEMORY =
  /heap out of memory|Allocation failed|exit(?:ed with)? code (?:134|3221226505)\b/i;
// What `bun run` prints once a script exits non-zero.
const FAILURE_LINE = /^error: script "/;

/** @param {readonly string[]} lines @param {RegExp} pattern @returns {string | undefined} */
function lastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) {
      return lines[index].trim();
    }
  }
  return undefined;
}

/** The lines the failing step printed: from its `$ command` line to the failure line. */
/** @param {readonly string[]} lines @returns {{command: string, output: string[]} | undefined} */
function failingStep(lines) {
  const end = lines.findIndex((line) => FAILURE_LINE.test(line));
  const stop = end === -1 ? lines.length : end;
  let start = -1;
  for (let index = stop - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('$ ')) {
      start = index;
      break;
    }
  }
  if (start === -1) {
    return undefined;
  }
  return {
    command: lines[start].slice(2).trim(),
    output: lines
      .slice(start + 1, stop)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0),
  };
}

/** @param {readonly string[]} lines @returns {string[]} */
function jestFailures(lines) {
  const files = [];
  const tests = [];
  for (const line of lines) {
    const file = /^FAIL\s+(\S+)/.exec(line);
    if (file && !files.includes(`FAIL ${file[1]}`)) {
      files.push(`FAIL ${file[1]}`);
    }
    const test = /^\s*●\s+(.+)$/.exec(line);
    if (test && !tests.includes(`● ${test[1].trim()}`)) {
      tests.push(`● ${test[1].trim()}`);
    }
  }
  return [...files.slice(0, MAX_JEST_FILES), ...tests.slice(0, MAX_JEST_TESTS)];
}

/**
 * @param {string} rawLog the full output of `bun run verify`
 * @param {number} exitCode
 * @param {string} logPath where the full output was written
 */
function summarize(rawLog, exitCode, logPath) {
  const lines = rawLog.replace(ANSI, '').split(/\r?\n/);
  const out = [
    exitCode === 0 ? 'verify: PASS' : `verify: FAIL (exit ${exitCode})`,
  ];

  const facts = [
    lastMatch(lines, /^Test Suites:/),
    lastMatch(lines, /^Tests:/),
    lastMatch(lines, /dependency violations/),
  ].filter((fact) => fact !== undefined);
  out.push(...facts);
  if (lines.some((line) => /openapi\.json is valid OpenAPI/.test(line))) {
    out.push('OpenAPI valid');
  }

  if (exitCode !== 0) {
    const step = failingStep(lines);
    if (step === undefined) {
      // No step ran, as when the process dies before the first one: the end of
      // the log is the only clue there is.
      out.push(
        ...lines
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .slice(-MAX_TAIL_LINES),
      );
    } else {
      out.push(`failed step: ${step.command}`);
      const failures = jestFailures(lines);
      out.push(
        ...(failures.length > 0
          ? failures
          : step.output.slice(0, MAX_STEP_LINES)),
      );
    }
  }

  if (exitCode !== 0 && OUT_OF_MEMORY.test(rawLog)) {
    out.push(
      'out of memory, not a code failure: free RAM (stop Docker/WSL, end stale jest processes) and run again',
    );
  }

  out.push(`full log: ${logPath}`);
  return out.join('\n');
}

/** @param {Date} now */
function logFileName(now) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `verify-${stamp}.log`;
}

function run() {
  const directory = path.join(tmpdir(), 'aihub-verify');
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, logFileName(new Date()));

  const child = spawn('bun', ['run', 'verify'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** @type {Buffer[]} */
  const chunks = [];
  child.stdout.on('data', (/** @type {Buffer} */ chunk) => chunks.push(chunk));
  child.stderr.on('data', (/** @type {Buffer} */ chunk) => chunks.push(chunk));
  child.on('error', (error) => {
    console.error(`verify:summary could not start bun: ${error.message}`);
    process.exit(1);
  });
  child.on('close', (code) => {
    const log = Buffer.concat(chunks).toString('utf8');
    writeFileSync(logPath, log);
    const status = code ?? 1;
    console.log(summarize(log, status, logPath));
    process.exit(status);
  });
}

if (require.main === module) {
  run();
}

module.exports = { summarize, logFileName };
