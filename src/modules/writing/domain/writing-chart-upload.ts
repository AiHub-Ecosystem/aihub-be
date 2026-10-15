export const WRITING_CHART_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type WritingChartContentType =
  (typeof WRITING_CHART_CONTENT_TYPES)[number];
export type WritingChartEnvironment = 'production' | 'sandbox';

export interface WritingChartUploadIntent {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: WritingChartEnvironment;
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly contentType: WritingChartContentType;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'open' | 'rejected' | 'publishing';
}

export type WritingChartAsset = Omit<WritingChartUploadIntent, 'status'> & {
  readonly status: 'published' | 'deleted';
  readonly publishedAt: Date;
  readonly retentionExpiresAt: Date;
  readonly imageUrl: string;
};

export function isWritingChartEnvironment(
  value: string,
): value is WritingChartEnvironment {
  return value === 'production' || value === 'sandbox';
}

export function isWritingChartUploadStatus(
  value: string,
): value is WritingChartUploadIntent['status'] {
  return value === 'open' || value === 'rejected' || value === 'publishing';
}

export function isWritingChartContentType(
  value: string | undefined,
): value is WritingChartContentType {
  return WRITING_CHART_CONTENT_TYPES.some(
    (contentType) => contentType === value,
  );
}

export function isWritingChartAssetId(value: string): boolean {
  return /^chart_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export function writingChartStagingKey(assetId: string): string {
  return `writing-charts/${assetId}/staging`;
}

export function writingChartPublishedKey(assetId: string): string {
  return `writing-charts/${assetId}/published`;
}
