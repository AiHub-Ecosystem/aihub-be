import { sanitizeRasterImage } from '@/common/image/raster-image';
import type { WritingChartContentType } from '@/modules/writing/chart-uploads/domain/writing-chart-upload';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
} from './writing-chart-upload.policy';

export async function sanitizeWritingChartImage(input: {
  readonly contentType: WritingChartContentType;
  readonly bytes: Uint8Array;
}): Promise<
  | { readonly kind: 'sanitized'; readonly bytes: Buffer }
  | { readonly kind: 'too_large' }
  | undefined
> {
  return sanitizeRasterImage({
    contentType: input.contentType,
    bytes: input.bytes,
    maxBytes: WRITING_CHART_MAX_BYTES,
    maxPixels: WRITING_CHART_MAX_PIXELS,
  });
}
