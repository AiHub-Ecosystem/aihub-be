import { fork, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { stopApp } from './dev-runner.mjs';

/**
 * Runs `run` while `process.platform` reports `platform`, so the POSIX branch
 * of `stopApp` is exercised on any host (the CI runner is Linux, a workstation
 * may be Windows).
 */
async function onPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('dev runner graceful lifecycle', () => {
  it('delivers a shutdown signal that lets shutdown hooks run and completes cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-shutdown-'));
    try {
      const markerFile = join(directory, 'hooks-ran.log');
      const childScript = join(directory, 'child.mjs');
      writeFileSync(
        childScript,
        `
        import { appendFileSync } from 'node:fs';
        import process from 'node:process';

        process.on('SIGTERM', async () => {
          appendFileSync(${JSON.stringify(markerFile)}, 'onModuleDestroy-complete\\n');
          process.exit(0);
        });

        process.on('message', (msg) => {
          if (msg === 'shutdown') {
            process.emit('SIGTERM');
          }
        });

        process.stdout.write('CHILD_READY\\n');
        setInterval(() => {}, 1000);
        `,
      );

      const child = fork(childScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (data: unknown) => {
          if (String(data).includes('CHILD_READY')) resolve();
        });
      });

      const result = await stopApp(child, 3000);

      expect(result.code).toBe(0);
      expect(child.exitCode).toBe(0);
      // Assert shutdown hooks ran
      expect(readFileSync(markerFile, 'utf8')).toContain(
        'onModuleDestroy-complete',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves no orphaned process when stopped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-orphan-'));
    try {
      const childScript = join(directory, 'child.mjs');
      writeFileSync(
        childScript,
        `
        process.on('message', (msg) => {
          if (msg === 'shutdown') process.exit(0);
        });
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
        `,
      );

      const child = fork(childScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const pid = child.pid;

      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (d: unknown) => {
          if (String(d).includes('READY')) resolve();
        });
      });

      await stopApp(child, 3000);

      const isAlive = (p: number | undefined): boolean => {
        if (p === undefined) return false;
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      };

      expect(isAlive(pid)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('completes in-flight HTTP requests before shutting down', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-inflight-'));
    try {
      const childScript = join(directory, 'server.mjs');
      writeFileSync(
        childScript,
        `
        import { createServer } from 'node:http';
        import process from 'node:process';

        let activeRequests = 0;
        const server = createServer(async (req, res) => {
          activeRequests++;
          await new Promise((resolve) => setTimeout(resolve, 300));
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('REQUEST_FINISHED');
          activeRequests--;
        });

        process.on('message', (msg) => {
          if (msg === 'shutdown') {
            server.close(() => {
              process.exit(0);
            });
          }
        });

        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          process.stdout.write('PORT:' + port + '\\n');
        });
        `,
      );

      const child = fork(childScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      const port = await new Promise<number>((resolve) => {
        child.stdout?.on('data', (d: unknown) => {
          const match = /PORT:(\d+)/.exec(String(d));
          if (match?.[1]) resolve(Number(match[1]));
        });
      });

      // Start an in-flight request
      const requestPromise = fetch(`http://127.0.0.1:${port}`).then((r) =>
        r.text(),
      );

      // Wait a moment for request to be in flight
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop app while request is in flight
      await stopApp(child, 5000);

      // In-flight request must have succeeded
      const responseText = await requestPromise;
      expect(responseText).toBe('REQUEST_FINISHED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not invoke taskkill during graceful stop', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-notaskkill-'));
    try {
      const childScript = join(directory, 'child.mjs');
      writeFileSync(
        childScript,
        `
        process.on('message', (msg) => {
          if (msg === 'shutdown') process.exit(0);
        });
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
        `,
      );

      const child = fork(childScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (d: unknown) => {
          if (String(d).includes('READY')) resolve();
        });
      });

      const result = await stopApp(child, 3000);
      expect(result.code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets a connected child finish its IPC shutdown before any POSIX signal (#1629)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-ipc-first-'));
    try {
      const childScript = join(directory, 'child.mjs');
      // No SIGTERM handler: a signal sent beside the message kills the child
      // before the delayed exit, which is how the Linux CI lane failed.
      writeFileSync(
        childScript,
        `
        process.on('message', (msg) => {
          if (msg === 'shutdown') setTimeout(() => process.exit(0), 100);
        });
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
        `,
      );

      const child = fork(childScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (d: unknown) => {
          if (String(d).includes('READY')) resolve();
        });
      });

      const result = await onPlatform('linux', () => stopApp(child, 3000));
      expect(result).toEqual({ code: 0, signal: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('signals a child without an IPC channel with SIGTERM on POSIX (#1629)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-dev-no-ipc-'));
    try {
      const childScript = join(directory, 'child.mjs');
      writeFileSync(
        childScript,
        `
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
        `,
      );

      const child = spawn(process.execPath, [childScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const kill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals | number): boolean => {
        signals.push(signal);
        return kill(signal);
      };

      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (d: unknown) => {
          if (String(d).includes('READY')) resolve();
        });
      });

      await onPlatform('linux', () => stopApp(child, 3000));
      expect(signals[0]).toBe('SIGTERM');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
