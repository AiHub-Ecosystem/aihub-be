import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/')) {
      return nextResolve(specifier, context);
    }

    const sourcePath = resolve(
      process.cwd(),
      'src',
      specifier.slice(2).replace(/\.js$/, '.ts'),
    );
    return nextResolve(pathToFileURL(sourcePath).href, context);
  },
});

const domain = await import('@/modules/writing/domain/writing-chart-upload.js');

void describe('Writing chart upload domain values with node:test', () => {
  void it('validates content types, environments, and intent states', () => {
    assert.equal(domain.isWritingChartContentType('image/webp'), true);
    assert.equal(domain.isWritingChartContentType('image/svg+xml'), false);
    assert.equal(domain.isWritingChartEnvironment('sandbox'), true);
    assert.equal(domain.isWritingChartEnvironment('test'), false);
    assert.equal(domain.isWritingChartUploadStatus('open'), true);
    assert.equal(domain.isWritingChartUploadStatus('published'), false);
  });

  void it('recognizes asset ids and derives the staging/public keys', () => {
    const assetId = 'chart_01J00000000000000000000001';
    assert.equal(domain.isWritingChartAssetId(assetId), true);
    assert.equal(
      domain.writingChartStagingKey(assetId),
      `writing-charts/${assetId}/staging`,
    );
    assert.equal(
      domain.writingChartPublishedKey(assetId),
      `writing-charts/${assetId}/published`,
    );
    assert.equal(domain.isWritingChartAssetId('chart_invalid'), false);
  });
});
