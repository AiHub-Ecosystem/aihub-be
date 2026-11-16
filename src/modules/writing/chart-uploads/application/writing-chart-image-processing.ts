import { serializeRasterImageProcessing } from '@/common/image/raster-image';

export function serializeWritingChartImageProcessing<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return serializeRasterImageProcessing(operation);
}
