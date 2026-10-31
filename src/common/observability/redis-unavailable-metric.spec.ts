describe('aihub_redis_unavailable_total', () => {
  it('exposes every bounded seam at zero before it is ever unavailable', async () => {
    const metrics = await import('./metrics');
    await import('./redis-unavailable-metric');

    const samples = (await metrics.getMetrics())
      .split('\n')
      .filter((line) => line.startsWith('aihub_redis_unavailable_total{'));
    expect(samples).toHaveLength(13);
    for (const seam of [
      'graded_admission',
      'concurrency',
      'rate_limit',
      'quota',
      'retry_budget',
      'api_key_cache',
      'api_key_cache_invalidation_revoke',
      'api_key_cache_invalidation_rotate',
      'api_key_cache_invalidation_suspension',
      'auth_failure_counter',
      'auth_rate_limit',
      'jwks_cache',
      'email_send_rate',
    ]) {
      expect(samples).toContain(
        `aihub_redis_unavailable_total{seam="${seam}"} 0`,
      );
    }
  });

  it('counts one unavailable answer under its seam', async () => {
    const metrics = await import('./metrics');
    const { recordRedisUnavailable } = await import(
      './redis-unavailable-metric'
    );

    recordRedisUnavailable('email_send_rate');

    expect(await metrics.getMetrics()).toContain(
      'aihub_redis_unavailable_total{seam="email_send_rate"} 1',
    );
  });

  it('supports the three fixed API-key invalidation seams', async () => {
    const metrics = await import('./metrics');
    const { recordRedisUnavailable } = await import(
      './redis-unavailable-metric'
    );
    const seams = [
      'api_key_cache_invalidation_revoke',
      'api_key_cache_invalidation_rotate',
      'api_key_cache_invalidation_suspension',
    ] as const;

    for (const seam of seams) recordRedisUnavailable(seam);

    const samples = (await metrics.getMetrics())
      .split('\n')
      .filter((line) => line.startsWith('aihub_redis_unavailable_total{'));
    for (const seam of seams) {
      expect(samples).toContain(
        `aihub_redis_unavailable_total{seam="${seam}"} 1`,
      );
    }
    expect(samples).toHaveLength(13);
  });
});
