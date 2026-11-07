describe('aihub_speaking_audio_url_rejected_total', () => {
  it('exposes the four bounded reasons and increments each once', async () => {
    const metrics = await import('./metrics');
    const { recordSpeakingAudioUrlRejection } = await import(
      './speaking-audio-url-rejection-metric'
    );
    const reasons = [
      'malformed',
      'traversal',
      'foreign_tenant',
      'unapproved_bucket',
    ] as const;

    for (const reason of reasons) recordSpeakingAudioUrlRejection(reason);

    const samples = (await metrics.getMetrics())
      .split('\n')
      .filter((line) =>
        line.startsWith('aihub_speaking_audio_url_rejected_total{'),
      );
    expect(samples).toEqual(
      reasons.map(
        (reason) =>
          `aihub_speaking_audio_url_rejected_total{reason="${reason}"} 1`,
      ),
    );
  });
});
