describe('aihub_redis_unavailable_total', () => {
  it('exposes the email send-rate seam at zero before it is ever unavailable, so its first answer is an increase', async () => {
    // A fresh module, so nothing another spec recorded in the shared registry counts.
    await jest.isolateModulesAsync(async () => {
      const metrics = await import('./metrics');
      await import('./redis-unavailable-metric');

      expect(await metrics.getMetrics()).toContain(
        'aihub_redis_unavailable_total{seam="email_send_rate"} 0',
      );
    });
  });

  it('counts one unavailable answer under its seam', async () => {
    await jest.isolateModulesAsync(async () => {
      const metrics = await import('./metrics');
      const { recordRedisUnavailable } = await import(
        './redis-unavailable-metric'
      );

      recordRedisUnavailable('email_send_rate');

      expect(await metrics.getMetrics()).toContain(
        'aihub_redis_unavailable_total{seam="email_send_rate"} 1',
      );
    });
  });
});
