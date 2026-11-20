import Redis from 'ioredis';

export interface RedisClientOptions {
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs?: number;
  readonly autoResendUnfulfilledCommands?: boolean;
  readonly lazyConnect?: boolean;
}

/**
 * Shared options for request-path adapters: a mutating EVAL must never replay
 * after a reconnect (it double-counts), so replay stays off, and a connect
 * that cannot finish fails in 1 s.
 */
export const REDIS_NO_REPLAY_OPTIONS = {
  connectTimeoutMs: 1_000,
  autoResendUnfulfilledCommands: false,
} as const;

/**
 * The one request-path Redis client: no offline queue, one retry per request,
 * no reconnect replay, and no unhandled `error` event. A command that cannot
 * be answered fails inside `commandTimeoutMs` instead of queueing behind a dead
 * socket. Each caller states its own timeouts, since they come from its
 * measured round trip.
 */
export function createRedisClient(
  url: string,
  options: RedisClientOptions,
): Redis {
  const client = new Redis(url, {
    commandTimeout: options.commandTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // ioredis defaults this to true and replays queued commands after a
    // reconnect; a mutating EVAL would then run twice (#1345, #645).
    autoResendUnfulfilledCommands:
      options.autoResendUnfulfilledCommands ?? false,
    ...(options.lazyConnect === undefined
      ? {}
      : { lazyConnect: options.lazyConnect }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeout: options.connectTimeoutMs }),
  });
  client.on('error', () => undefined);
  return client;
}
