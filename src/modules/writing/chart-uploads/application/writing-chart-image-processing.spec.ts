import { serializeWritingChartImageProcessing } from './writing-chart-image-processing';

describe('serializeWritingChartImageProcessing', () => {
  it('allows only one image processing operation at a time', async () => {
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      [1, 2, 3].map(() =>
        serializeWritingChartImageProcessing(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

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
