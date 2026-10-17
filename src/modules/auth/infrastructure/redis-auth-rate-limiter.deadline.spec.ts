import { type Server, type Socket, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import { RedisAuthRateLimiter } from './redis-auth-rate-limiter';

interface ParsedCommand {
  readonly arguments: readonly string[];
  readonly bytesRead: number;
}

function parseCommand(buffer: Buffer): ParsedCommand | undefined {
  const firstLineEnd = buffer.indexOf('\r\n');
  if (firstLineEnd < 0 || buffer[0] !== 42) {
    return undefined;
  }

  const argumentCount = Number(buffer.toString('utf8', 1, firstLineEnd));
  let offset = firstLineEnd + 2;
  const arguments_: string[] = [];

  for (let index = 0; index < argumentCount; index += 1) {
    const lengthLineEnd = buffer.indexOf('\r\n', offset);
    if (lengthLineEnd < 0 || buffer[offset] !== 36) {
      return undefined;
    }

    const byteLength = Number(
      buffer.toString('utf8', offset + 1, lengthLineEnd),
    );
    offset = lengthLineEnd + 2;
    if (buffer.length < offset + byteLength + 2) {
      return undefined;
    }

    arguments_.push(buffer.toString('utf8', offset, offset + byteLength));
    offset += byteLength + 2;
  }

  return { arguments: arguments_, bytesRead: offset };
}

async function createBlackholeRedis() {
  const sockets = new Set<Socket>();
  let evalCount = 0;
  let resolveReadyCheck: (() => void) | undefined;
  const readyCheck = new Promise<void>((resolve) => {
    resolveReadyCheck = resolve;
  });
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let command = parseCommand(pending);
      while (command !== undefined) {
        pending = pending.subarray(command.bytesRead);
        const name = command.arguments[0]?.toLowerCase();
        if (name === 'hello') {
          socket.write(
            '%7\r\n+server\r\n+redis\r\n+version\r\n+7.0.0\r\n+proto\r\n:3\r\n+id\r\n:1\r\n+mode\r\n+standalone\r\n+role\r\n+master\r\n+modules\r\n*0\r\n',
          );
        } else if (name === 'info') {
          const info = '# Server\r\nredis_version:7.0.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
          resolveReadyCheck?.();
        } else if (name === 'eval') {
          evalCount += 1;
        } else {
          socket.write('+OK\r\n');
        }
        command = parseCommand(pending);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `redis://127.0.0.1:${address.port}`,
    readyCheck,
    get evalCount() {
      return evalCount;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe('RedisAuthRateLimiter command deadline', () => {
  it('falls back promptly when connected Redis stops answering commands', async () => {
    const redis = await createBlackholeRedis();
    const limiter = new RedisAuthRateLimiter(redis.url, () => 1_000);
    const input = {
      scope: 'login_ip' as const,
      key: '203.0.113.7',
      limit: 1,
      windowMs: 1_000,
    };
    const startedAt = performance.now();

    try {
      await limiter.consume({ ...input, key: 'connection-warmup' });
      await settleWithin(redis.readyCheck, 750);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      await expect(settleWithin(limiter.consume(input), 750)).resolves.toEqual({
        allowed: true,
      });
      await expect(settleWithin(limiter.check(input), 750)).resolves.toEqual({
        allowed: false,
        retryAfterMs: 1_000,
      });
      await expect(settleWithin(limiter.consume(input), 750)).resolves.toEqual({
        allowed: false,
        retryAfterMs: 1_000,
      });

      expect(redis.evalCount).toBe(3);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await limiter.onModuleDestroy();
      await redis.close();
    }
  });
});
