describe('aihub_rejected_total', () => {
  it('exposes exactly the four bounded reasons and increments each once', async () => {
    const metrics = await import('./metrics');
    const { recordRejected } = await import('./rejected-metric');
    const reasons = ['rate_limit', 'quota', 'concurrency', 'auth'] as const;

    for (const reason of reasons) recordRejected(reason);

    const samples = (await metrics.getMetrics())
      .split('\n')
      .filter((line) => line.startsWith('aihub_rejected_total{'));
    expect(samples).toEqual(
      reasons.map((reason) => `aihub_rejected_total{reason="${reason}"} 1`),
    );
  });
});
