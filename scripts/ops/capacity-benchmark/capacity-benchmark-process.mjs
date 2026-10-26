import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/** @typedef {import('node:child_process').StdioOptions} StdioOptions */
/** @typedef {{timeout?: number, killProcessGroup?: boolean, killSignal?: NodeJS.Signals, stdio?: StdioOptions, env?: NodeJS.ProcessEnv, allowNonZeroExit?: boolean, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void}} RunProcessOptions */

/** @param {string} command @param {readonly string[]} args @param {RunProcessOptions} [options] @returns {Promise<{stdout: string, stderr: string, exitCode: number | null}>} */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const killProcessGroup =
      options.killProcessGroup === true && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      detached: killProcessGroup,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      timeout: killProcessGroup ? undefined : options.timeout,
      killSignal: options.killSignal,
    });
    /** @type {NodeJS.Timeout | undefined} */
    let timeoutId;
    let stdout = '';
    let stderr = '';
    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout = appendLimited(stdout, text);
        options.onStdout?.(text);
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr = appendLimited(stderr, text);
        options.onStderr?.(text);
      });
    }
    child.once('spawn', () => {
      if (!killProcessGroup || options.timeout === undefined) return;
      timeoutId = setTimeout(() => {
        const signal = options.killSignal ?? 'SIGTERM';
        if (child.pid === undefined) {
          child.kill(signal);
        } else {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ESRCH'
            ) {
              return;
            }
            child.kill(signal);
          }
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        reject(new Error(`${command} timed out after ${options.timeout}ms`));
      }, options.timeout);
    });
    child.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (code !== 0 && !options.allowNonZeroExit) {
        reject(
          new Error(
            `${command} ${
              code === null ? `was terminated by ${signal}` : `exited ${code}`
            }: ${lastLines(stderr || stdout, 30)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/** @param {string} value @param {number} limit */
export function lastLines(value, limit) {
  return value
    .split(/\r?\n/)
    .slice(-limit)
    .map((line) => (line.length > 2000 ? '[omitted long output line]' : line))
    .join('\n')
    .trim();
}

/** @param {string} current @param {string} chunk */
function appendLimited(current, chunk) {
  const result = current + chunk;
  return result.length > 8_000_000 ? result.slice(-8_000_000) : result;
}
