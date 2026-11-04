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

export interface QuotaCounterOverwriteRequest {
  readonly organizationId: string;
  readonly month: string;
  readonly count: number;
}

export interface QuotaCounterReadRequest {
  readonly organizationId: string;
  readonly month: string;
}

export interface QuotaCounterOverwritePort {
  read(request: QuotaCounterReadRequest): Promise<number>;
  overwrite(request: QuotaCounterOverwriteRequest): Promise<void>;
}
