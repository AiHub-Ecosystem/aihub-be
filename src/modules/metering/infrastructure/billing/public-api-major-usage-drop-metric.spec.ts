describe('aihub_public_api_major_usage_samples_dropped_total', () => {
  it('exposes the number of samples discarded at the buffer bound', async () => {
    const metrics = await import('@/common/observability/metrics');
    const { recordPublicApiMajorUsageDrop } = await import(
      './public-api-major-usage-drop-metric'
    );

    recordPublicApiMajorUsageDrop();
    recordPublicApiMajorUsageDrop();

    expect(await metrics.getMetrics()).toContain(
      'aihub_public_api_major_usage_samples_dropped_total 2',
    );
  });
});
