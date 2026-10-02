'use strict';

/**
 * `pnpm verify:summary`: the same loop as `pnpm verify`, reported in a few
 * lines. The full output goes to a log file of its own, so reading the result
 * costs a handful of lines instead of the 20 to 60 KB the loop prints, and two
 * runs can never write into one file.
 *
 * Plain CommonJS so the spec can import `summarize` and `logFileName`, as with
 * the other scripts a test needs to reach.
 */

const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g');
const MAX_STEP_LINES = 25;
const MAX_JEST_FILES = 10;
const MAX_JEST_TESTS = 8;
const MAX_TAIL_LINES = 6;

function lastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) {
      return lines[index].trim();
    }
  }
  return undefined;
}

/** The lines the failing step printed: from its `$ command` line to ELIFECYCLE. */
function failingStep(lines) {
  const end = lines.findIndex((line) => line.includes('ELIFECYCLE'));
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
 * @param {string} rawLog the full output of `pnpm verify`
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

  out.push(`full log: ${logPath}`);
  return out.join('\n');
}

function logFileName(now) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `verify-${stamp}.log`;
}

function run() {
  const directory = join(tmpdir(), 'aihub-verify');
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, logFileName(new Date()));

  const windows = process.platform === 'win32';
  const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', ['verify'], {
    cwd: join(__dirname, '..'),
    shell: windows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  child.on('error', (error) => {
    console.error(`verify:summary could not start pnpm: ${error.message}`);
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
