import { RasterImageProcessingCapacityError } from '@/common/image/raster-image';
import { reserveAvatarRasterImageProcessing } from '@/modules/avatar/application/avatar-upload.policy';
import { serializeWritingChartImageProcessing } from './writing-chart-image-processing';
import { reserveWritingChartRasterImageProcessing } from './writing-chart-upload.policy';

describe('serializeWritingChartImageProcessing', () => {
  it('bounds retained processing requests independently by lane', () => {
    const avatarReservations = [
      reserveAvatarRasterImageProcessing(),
      reserveAvatarRasterImageProcessing(),
    ];
    const chartReservations = [
      reserveWritingChartRasterImageProcessing(),
      reserveWritingChartRasterImageProcessing(),
      reserveWritingChartRasterImageProcessing(),
      reserveWritingChartRasterImageProcessing(),
    ];
    try {
      expect(() => reserveAvatarRasterImageProcessing()).toThrow(
        RasterImageProcessingCapacityError,
      );
      expect(() => reserveWritingChartRasterImageProcessing()).toThrow(
        RasterImageProcessingCapacityError,
      );
    } finally {
      for (const reservation of [...avatarReservations, ...chartReservations])
        reservation.release();
    }
  });

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
      [1, 2, 3].map(() => {
        const admission = reserveWritingChartRasterImageProcessing();
        return serializeWritingChartImageProcessing(
          admission,
          new AbortController().signal,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (active === 1) {
              markFirstStarted?.();
              await firstGate;
            }
            active -= 1;
          },
        ).finally(() => admission.release());
      }),
    );
    await firstStarted;
    expect(maximumActive).toBe(1);
    releaseFirst?.();
    await operations;

    expect(maximumActive).toBe(1);
  });

  it('continues processing after an operation rejects', async () => {
    const failedAdmission = reserveWritingChartRasterImageProcessing();
    await expect(
      serializeWritingChartImageProcessing(
        failedAdmission,
        new AbortController().signal,
        async () => {
          throw new Error('processing failed');
        },
      ).finally(() => failedAdmission.release()),
    ).rejects.toThrow('processing failed');

    const nextAdmission = reserveWritingChartRasterImageProcessing();
    await expect(
      serializeWritingChartImageProcessing(
        nextAdmission,
        new AbortController().signal,
        async () => 'processed',
      ).finally(() => nextAdmission.release()),
    ).resolves.toBe('processed');
  });
});
