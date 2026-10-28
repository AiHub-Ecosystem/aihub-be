export type RedisCutoverDecision =
  | { readonly kind: 'shared'; readonly identity: string }
  | { readonly kind: 'hold-drain'; readonly reason: string };

export interface RedisEndpoints {
  readonly url: string;
  readonly sandbox_url: string;
  readonly email_send_rate_url: string;
}

function endpointIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Redis URL is invalid');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('Redis URL must use redis or rediss');
  }
  const database = url.pathname.slice(1) || '0';
  if (!/^\d+$/u.test(database)) throw new Error('Redis database is invalid');
  const port = url.port || (url.protocol === 'rediss:' ? '6380' : '6379');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}/${database}`;
}

/** A separate Redis DB silently multiplies counters and permits during rollback. */
export function redisCutoverDecision(
  previousUrl: string,
  candidateUrl: string,
): RedisCutoverDecision {
  const previous = endpointIdentity(previousUrl);
  const candidate = endpointIdentity(candidateUrl);
  return previous === candidate
    ? { kind: 'shared', identity: candidate }
    : {
        kind: 'hold-drain',
        reason: `Redis endpoint changed from ${previous} to ${candidate}`,
      };
}

export function requireSharedRedisEndpoints(
  previous: RedisEndpoints,
  candidate: RedisEndpoints,
  previousSha: string,
  candidateSha: string,
): string[] {
  return (['url', 'sandbox_url', 'email_send_rate_url'] as const).map(
    (channel) => {
      let decision: RedisCutoverDecision;
      try {
        decision = redisCutoverDecision(previous[channel], candidate[channel]);
      } catch {
        throw new Error(
          `RELEASE HOLD: N-1 ${previousSha} and N ${candidateSha} have an invalid ${channel} Redis endpoint`,
        );
      }
      if (decision.kind === 'hold-drain') {
        throw new Error(
          `RELEASE HOLD: N-1 ${previousSha} and N ${candidateSha}; ${channel}: ${decision.reason}`,
        );
      }
      return decision.identity;
    },
  );
}
