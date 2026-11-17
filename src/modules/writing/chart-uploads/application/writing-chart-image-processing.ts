import {
  reserveRasterImageProcessing,
  serializeRasterImageProcessing,
} from '@/common/image/raster-image';

export function serializeWritingChartImageProcessing<T>(
  admission: ReturnType<typeof reserveRasterImageProcessing>,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeRasterImageProcessing(admission, signal, operation);
}
