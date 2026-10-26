/**
 * The shared runner for the repo's file-scan integrity checks (#1025).
 *
 * A check used to copy the same scaffolding as its neighbours: the recursive
 * source discovery, the `.spec.ts` exclusion, the posix path normalization,
 * reading each file, formatting violations, and the exit code. This runner
 * owns that lifecycle, so a check only describes what to scan and how to
 * judge one file. Reporting stays uniform: every violation is one stderr line
 * formatted as `path: detail`, or `path:line: detail` when the visitor knows
 * the line; exit code 1 when any violation exists, the success line
 * otherwise.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

/** @param {string} dir @returns {string[]} */
function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts'))
      out.push(p);
  }
  return out;
}

/** @param {string} relativePath @param {number | undefined} line @param {string} detail @returns {string} */
function formatViolation(relativePath, line, detail) {
  return line === undefined
    ? `${relativePath}: ${detail}`
    : `${relativePath}:${line}: ${detail}`;
}

/**
 * Builds one standalone check. `directory` is evaluated when the check runs,
 * not when it is defined, so a spec can execute the script against a fixture
 * tree by changing the working directory. `visitFile` receives every scanned
 * file and returns its violations as `{ line, detail }` pairs; the runner
 * formats each against the file path, prints it, and handles the exit code.
 */
/**
 * @param {{directory: () => string, successMessage: string, visitFile: (input: {relativePath: string, source: string}) => Array<{line?: number, detail: string}>}} options
 * @returns {() => void}
 */
export function defineFileVisitorCheck({
  directory,
  successMessage,
  visitFile,
}) {
  return () => {
    const root = process.cwd();
    let failed = false;
    for (const file of collectFiles(directory())) {
      const relativePath = relative(root, file).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8');
      for (const { line, detail } of visitFile({ relativePath, source })) {
        console.error(formatViolation(relativePath, line, detail));
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
    else console.log(successMessage);
  };
}
