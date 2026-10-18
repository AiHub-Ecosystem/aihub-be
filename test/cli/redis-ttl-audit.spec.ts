import {
  type RedisTtlAuditClient,
  runRedisTtlAuditCommand,
} from '@/cli/redis-ttl-audit';

class FakeRedis implements RedisTtlAuditClient {
  readonly pages: [string, string[]][] = [];
  readonly ttls = new Map<string, number>();
  quitCalls = 0;

  async scan(): Promise<[string, string[]]> {
    const page = this.pages.shift();
    if (page === undefined) {
      throw new Error('unexpected scan');
    }
    return page;
  }

  async getTtls(keys: readonly string[]): Promise<readonly number[]> {
    return keys.map((key) => this.ttls.get(key) ?? -2);
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
  }
}

describe('runRedisTtlAuditCommand', () => {
  it('reports non-expiring AIHUB keys without printing key names', async () => {
    const redis = new FakeRedis();
    redis.pages.push(
      ['7', ['aihub:v1:rl:ak_secret:1', 'aihub:v1:jwks-generation:org_acme']],
      ['0', ['aihub:v1:key:hash', 'aihub:v1:authfail:203.0.113.10']],
    );
    redis.ttls.set('aihub:v1:rl:ak_secret:1', -1);
    redis.ttls.set('aihub:v1:jwks-generation:org_acme', -1);
    redis.ttls.set('aihub:v1:key:hash', 60);
    redis.ttls.set('aihub:v1:authfail:203.0.113.10', -2);
    const output: string[] = [];

    await expect(
      runRedisTtlAuditCommand({
        redisUrl: 'redis://unused',
        client: redis,
        emit: (line) => output.push(line),
      }),
    ).resolves.toEqual({
      scanHits: 4,
      missingTtl: 1,
      intentionallyPersistent: 1,
    });

    expect(output).toEqual([
      JSON.stringify({
        event: 'redis_ttl_audit',
        scan_hits: 4,
        missing_ttl: 1,
        intentionally_persistent: 1,
        status: 'failed',
      }),
    ]);
    expect(output[0]).not.toContain('ak_secret');
    expect(output[0]).not.toContain('203.0.113.10');
    expect(redis.quitCalls).toBe(1);
  });

  it('rejects a failed scan and still closes Redis', async () => {
    const redis = new FakeRedis();
    redis.pages.push(['invalid-cursor', []]);

    await expect(
      runRedisTtlAuditCommand({ redisUrl: 'redis://unused', client: redis }),
    ).rejects.toThrow('Redis TTL audit returned an invalid cursor');
    expect(redis.quitCalls).toBe(1);
  });

  it('requires a Redis URL', async () => {
    await expect(runRedisTtlAuditCommand({ redisUrl: '' })).rejects.toThrow(
      'REDIS_URL is required',
    );
  });
});
