export type {
  QuotaCounterOverwritePort,
  QuotaCounterOverwriteRequest,
  QuotaCounterReadRequest,
} from '@/modules/gateway/application/quota-counter.port';

export interface QuotaReconciliationTarget {
  readonly month: string;
  readonly from: Date;
  readonly to: Date;
}

export interface QuotaOrganizationSnapshot {
  readonly organizationId: string;
  readonly monthlyRequestQuota: number | null;
  readonly billableRequestCount: number;
}

export interface QuotaReconciliationSnapshotPort {
  list(
    target: QuotaReconciliationTarget,
  ): Promise<readonly QuotaOrganizationSnapshot[]>;
}
