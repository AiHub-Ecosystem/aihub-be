import type Redis from 'ioredis';

import {
  type RedisTtlAuditClient,
  adaptRedisTtlAuditClient,
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

describe('adaptRedisTtlAuditClient', () => {
  it('scans namespaced keys and avoids prefixing TTL keys twice', async () => {
    const pipeline = {
      ttl: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 60]]),
    };
    const scan = jest
      .fn()
      .mockResolvedValue([
        '0',
        ['aihub-sandbox:aihub:v1:quota:org_acme:2026-10'],
      ]);
    const redis = {
      options: { keyPrefix: 'aihub-sandbox:' },
      scan,
      pipeline: jest.fn().mockReturnValue(pipeline),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    } as unknown as Redis;
    const client = adaptRedisTtlAuditClient(redis);

    await expect(client.scan('0')).resolves.toEqual([
      '0',
      ['aihub:v1:quota:org_acme:2026-10'],
    ]);
    expect(scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'aihub-sandbox:aihub:*',
      'COUNT',
      250,
    );

    await expect(
      client.getTtls(['aihub:v1:quota:org_acme:2026-10']),
    ).resolves.toEqual([60]);
    expect(pipeline.ttl).toHaveBeenCalledWith(
      'aihub:v1:quota:org_acme:2026-10',
    );
  });

  it('rejects scanned keys outside the configured namespace', async () => {
    const redis = {
      options: { keyPrefix: 'aihub-sandbox:' },
      scan: jest.fn().mockResolvedValue(['0', ['aihub:v1:production-key']]),
    } as unknown as Redis;

    await expect(adaptRedisTtlAuditClient(redis).scan('0')).rejects.toThrow(
      'Redis TTL audit returned a key outside its configured namespace',
    );
  });
});
