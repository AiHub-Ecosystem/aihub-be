import type { WritingChartUploadStoragePort } from '@/modules/writing/application/writing-chart-upload.port';

export const CHART_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
export const BUCKET = 'aihub-writing-charts';

/** An in-memory object store the Writing chart service publishes to. */
export class ChartBucket {
  readonly published = new Set<string>();
  /** Private staging keys; a spec adds the one a customer upload would write. */
  readonly staged = new Set<string>();
  publishes = 0;
  /** Writes the object, then loses the acknowledgement. */
  loseNextAck = false;
  /** Holds the next public write until released. */
  gate: Promise<void> | undefined;
  private reportPublishStarted: (() => void) | undefined;
  readonly publishStarted = new Promise<void>((resolve) => {
    this.reportPublishStarted = resolve;
  });

  storage(): WritingChartUploadStoragePort {
    return {
      createUploadUrl: async () => ({
        url: 'https://storage.test/upload',
        fields: {},
        expiresAt: new Date(Date.now() + 300_000),
      }),
      inspectObject: async () => ({
        contentType: 'image/png',
        byteSize: CHART_PNG.length,
        bytes: new Uint8Array(CHART_PNG),
      }),
      publishObject: async (input) => {
        this.reportPublishStarted?.();
        await this.gate;
        this.publishes += 1;
        this.published.add(input.publishedKey);
        if (this.loseNextAck) {
          this.loseNextAck = false;
          throw new Error('connection reset after the write');
        }
      },
      publicUrl: (input) =>
        `https://s3.wispace.app/${BUCKET}/${input.publishedKey}`,
      deleteStagingObject: async (input) => {
        this.staged.delete(input.stagingKey);
      },
      deletePublishedObject: async (input) => {
        this.published.delete(input.publishedKey);
      },
    };
  }
}
