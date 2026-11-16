import { serializeWritingChartImageProcessing } from './writing-chart-image-processing';

describe('serializeWritingChartImageProcessing', () => {
  it('allows only one image processing operation at a time', async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const operations = Promise.all(
      [1, 2, 3].map(() =>
        serializeWritingChartImageProcessing(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (active === 1) {
            markFirstStarted?.();
            await firstGate;
          }
          active -= 1;
        }),
      ),
    );
    await firstStarted;
    expect(maximumActive).toBe(1);
    releaseFirst?.();
    await operations;

    expect(maximumActive).toBe(1);
  });

  it('continues processing after an operation rejects', async () => {
    await expect(
      serializeWritingChartImageProcessing(async () => {
        throw new Error('processing failed');
      }),
    ).rejects.toThrow('processing failed');

    await expect(
      serializeWritingChartImageProcessing(async () => 'processed'),
    ).resolves.toBe('processed');
  });
});
