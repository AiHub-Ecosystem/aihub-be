import Redis from 'ioredis';

export interface RedisClientOptions {
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs?: number;
  readonly autoResendUnfulfilledCommands?: boolean;
}

/**
 * The request-path Redis client: no offline queue, one retry per request, and
 * no unhandled `error` event. A command that cannot be answered fails inside
 * `commandTimeoutMs` instead of queueing behind a dead socket. Each caller
 * states its own timeouts, since they come from its measured round trip.
 */
export function createRedisClient(
  url: string,
  options: RedisClientOptions,
): Redis {
  const client = new Redis(url, {
    commandTimeout: options.commandTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeout: options.connectTimeoutMs }),
    ...(options.autoResendUnfulfilledCommands === undefined
      ? {}
      : {
          autoResendUnfulfilledCommands: options.autoResendUnfulfilledCommands,
        }),
  });
  client.on('error', () => undefined);
  return client;
}
