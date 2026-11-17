import { serializeRasterImageProcessing } from '@/common/image/raster-image';
import { reserveWritingChartRasterImageProcessing } from './writing-chart-upload.policy';

export function serializeWritingChartImageProcessing<T>(
  admission: ReturnType<typeof reserveWritingChartRasterImageProcessing>,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeRasterImageProcessing(admission, signal, operation);
}
