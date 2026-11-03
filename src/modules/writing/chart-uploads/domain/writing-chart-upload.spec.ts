import {
  isWritingChartAssetId,
  isWritingChartContentType,
  isWritingChartEnvironment,
  isWritingChartUploadStatus,
  writingChartPublishedKey,
  writingChartStagingKey,
} from './writing-chart-upload';

describe('Writing chart upload domain values', () => {
  it('validates content types, environments, and intent states', () => {
    expect(isWritingChartContentType('image/webp')).toBe(true);
    expect(isWritingChartContentType('image/svg+xml')).toBe(false);
    expect(isWritingChartEnvironment('sandbox')).toBe(true);
    expect(isWritingChartEnvironment('test')).toBe(false);
    expect(isWritingChartUploadStatus('open')).toBe(true);
    expect(isWritingChartUploadStatus('published')).toBe(false);
  });

  it('recognizes asset ids and derives the staging/public keys', () => {
    const assetId = 'chart_01J00000000000000000000001';
    expect(isWritingChartAssetId(assetId)).toBe(true);
    expect(writingChartStagingKey(assetId)).toBe(
      `writing-charts/${assetId}/staging`,
    );
    expect(writingChartPublishedKey(assetId)).toBe(
      `writing-charts/${assetId}/published`,
    );
    expect(isWritingChartAssetId('chart_invalid')).toBe(false);
  });
});
