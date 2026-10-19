import type { WritingChartEnvironment } from '@/modules/writing/domain/writing-chart-upload';

export type WritingChartOriginRevocationOutcome =
  | 'deleted'
  | 'already_absent'
  | 'failed';

export type WritingChartPublicEdgeOutcome =
  | 'serving'
  | 'not_serving'
  | 'redirect'
  | 'unavailable';

interface WritingChartRevocationAuditEvent {
  readonly assetId: string;
  readonly actorUserAccountId: string;
  readonly occurredAt: Date;
}

export type WritingChartRevocationAuditRecord =
  | (WritingChartRevocationAuditEvent & {
      readonly phase: 'requested';
      readonly originOutcome: null;
      readonly edgeOutcome: null;
      readonly edgeStatus: null;
    })
  | (WritingChartRevocationAuditEvent & {
      readonly phase: 'completed';
      readonly originOutcome: WritingChartOriginRevocationOutcome;
      readonly edgeOutcome: WritingChartPublicEdgeOutcome;
      readonly edgeStatus: number | null;
    });

export interface WritingChartRevocationAuditRepositoryPort {
  findActiveOperatorAccount(username: string): Promise<string | undefined>;
  append(record: WritingChartRevocationAuditRecord): Promise<void>;
  pruneExpired(cutoff: Date, batchSize: number): Promise<number>;
  close?(): Promise<void>;
}

export interface WritingChartRevocationStoragePort {
  deletePublishedObjectIfPresent(input: {
    readonly environment: WritingChartEnvironment;
    readonly publishedKey: string;
  }): Promise<'deleted' | 'already_absent'>;
}
