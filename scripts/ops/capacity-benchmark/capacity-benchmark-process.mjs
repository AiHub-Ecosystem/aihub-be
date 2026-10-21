import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const killProcessGroup =
      options.killProcessGroup === true && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      detached: killProcessGroup,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: killProcessGroup ? undefined : options.timeout,
      killSignal: options.killSignal,
    });
    let timeoutId;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
      options.onStderr?.(chunk);
    });
    child.once('spawn', () => {
      if (!killProcessGroup || options.timeout === undefined) return;
      timeoutId = setTimeout(() => {
        try {
          process.kill(-child.pid, options.killSignal ?? 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH')
            child.kill(options.killSignal ?? 'SIGTERM');
        }
        child.stdout.destroy();
        child.stderr.destroy();
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

export function lastLines(value, limit) {
  return value
    .split(/\r?\n/)
    .slice(-limit)
    .map((line) => (line.length > 2000 ? '[omitted long output line]' : line))
    .join('\n')
    .trim();
}

function appendLimited(current, chunk) {
  const result = current + chunk;
  return result.length > 8_000_000 ? result.slice(-8_000_000) : result;
}
