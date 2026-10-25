import { isUsableCount } from '@/common/counts/is-usable-count';
import {
  parseQuotaMonth,
  quotaPeriod,
} from '@/modules/gateway/public/quota-period';
import type {
  QuotaCounterOverwritePort,
  QuotaOrganizationSnapshot,
  QuotaReconciliationSnapshotPort,
  QuotaReconciliationTarget,
} from './quota-reconciliation.port';

export interface QuotaReconciledResult {
  readonly organizationId: string;
  readonly month: string;
  readonly billableCount: number;
  readonly quota: number;
  readonly overQuota: boolean;
  readonly excess: number;
}

export interface QuotaReconciliationSummary {
  readonly reconciled: number;
  readonly overQuota: number;
  readonly driftedOrganizations: number;
  readonly driftRequests: number;
  readonly failed: number;
}

export type QuotaReconciliationEvent =
  | { readonly type: 'reconciled'; readonly result: QuotaReconciledResult }
  | {
      readonly type: 'failed';
      readonly organizationId: string;
      readonly month: string;
      readonly reconciled: number;
      readonly overQuota: number;
      readonly driftedOrganizations: number;
      readonly driftRequests: number;
      readonly failed: 1;
    }
  | {
      readonly type: 'summary';
      readonly month: string;
      readonly summary: QuotaReconciliationSummary;
    };

class QuotaReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = QuotaReconciliationError.name;
  }
}

export class InvalidQuotaReconciliationMonthError extends QuotaReconciliationError {
  constructor() {
    super(
      'INVALID_QUOTA_RECONCILIATION_MONTH',
      'invalid quota reconciliation month',
    );
    this.name = InvalidQuotaReconciliationMonthError.name;
  }
}

export class QuotaReconciliationReadError extends QuotaReconciliationError {
  constructor() {
    super(
      'QUOTA_RECONCILIATION_READ_FAILED',
      'quota reconciliation read failed',
    );
    this.name = QuotaReconciliationReadError.name;
  }
}

export class QuotaReconciliationSnapshotError extends QuotaReconciliationError {
  constructor() {
    super(
      'QUOTA_RECONCILIATION_SNAPSHOT_INVALID',
      'quota reconciliation snapshot is invalid',
    );
    this.name = QuotaReconciliationSnapshotError.name;
  }
}

export class QuotaReconciliationWriteError extends QuotaReconciliationError {
  constructor(readonly organizationId: string) {
    super('QUOTA_RECONCILIATION_WRITE_FAILED', 'quota reconciliation failed');
    this.name = QuotaReconciliationWriteError.name;
  }
}

const QUOTA_HISTORY_MONTHS = 12;

function invalidMonth(): never {
  throw new InvalidQuotaReconciliationMonthError();
}

export function parseTargetMonth(
  raw: string | undefined,
  now: Date = new Date(),
): QuotaReconciliationTarget {
  if (Number.isNaN(now.getTime())) {
    throw new QuotaReconciliationError(
      'QUOTA_RECONCILIATION_CLOCK_INVALID',
      'current time is invalid',
    );
  }

  const current = quotaPeriod(now);
  const value = raw === undefined ? current.key : raw;
  const target = typeof value === 'string' ? parseQuotaMonth(value) : undefined;
  if (target === undefined) {
    return invalidMonth();
  }
  const currentIndex = current.year * 12 + current.monthIndex;
  const targetIndex = target.year * 12 + target.monthIndex;
  if (
    targetIndex > currentIndex ||
    targetIndex < currentIndex - QUOTA_HISTORY_MONTHS
  ) {
    return invalidMonth();
  }

  return {
    month: target.key,
    from: target.start,
    to: target.end,
  };
}

interface OrderedSnapshot {
  readonly organizationId: string;
  readonly billableCount: number;
  readonly quota: number;
  readonly overQuota: boolean;
  readonly excess: number;
}

function orderedSnapshots(
  snapshots: readonly QuotaOrganizationSnapshot[],
): readonly OrderedSnapshot[] {
  if (!Array.isArray(snapshots)) {
    throw new QuotaReconciliationSnapshotError();
  }
  return snapshots
    .filter((snapshot) => {
      if (
        typeof snapshot !== 'object' ||
        snapshot === null ||
        Array.isArray(snapshot)
      ) {
        throw new QuotaReconciliationSnapshotError();
      }
      return snapshot.monthlyRequestQuota !== null;
    })
    .map((snapshot) => {
      if (
        typeof snapshot.organizationId !== 'string' ||
        snapshot.organizationId.length === 0 ||
        !isUsableCount(snapshot.monthlyRequestQuota) ||
        !isUsableCount(snapshot.billableRequestCount)
      ) {
        throw new QuotaReconciliationSnapshotError();
      }

      const overQuota =
        snapshot.billableRequestCount > snapshot.monthlyRequestQuota;
      return {
        organizationId: snapshot.organizationId,
        billableCount: snapshot.billableRequestCount,
        quota: snapshot.monthlyRequestQuota,
        overQuota,
        excess: overQuota
          ? snapshot.billableRequestCount - snapshot.monthlyRequestQuota
          : 0,
      };
    })
    .sort((left, right) => {
      if (left.organizationId < right.organizationId) return -1;
      if (left.organizationId > right.organizationId) return 1;
      return 0;
    });
}

export class QuotaReconciliationService {
  constructor(
    private readonly snapshotPort: QuotaReconciliationSnapshotPort,
    private readonly counterPort: QuotaCounterOverwritePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(
    requestedMonth?: string,
    emit: (event: QuotaReconciliationEvent) => void = () => undefined,
  ): Promise<QuotaReconciliationSummary> {
    const target = parseTargetMonth(requestedMonth, this.now());
    let sourceSnapshots: readonly QuotaOrganizationSnapshot[];
    try {
      sourceSnapshots = await this.snapshotPort.list(target);
    } catch {
      throw new QuotaReconciliationReadError();
    }
    const snapshots = orderedSnapshots(sourceSnapshots);
    let reconciled = 0;
    let overQuota = 0;
    let driftedCount = 0;
    let driftRequests = 0;

    for (const snapshot of snapshots) {
      let currentCount: number;
      try {
        currentCount = await this.counterPort.read({
          organizationId: snapshot.organizationId,
          month: target.month,
        });
      } catch {
        emit({
          type: 'failed',
          organizationId: snapshot.organizationId,
          month: target.month,
          reconciled,
          overQuota,
          driftedOrganizations: driftedCount,
          driftRequests,
          failed: 1,
        });
        throw new QuotaReconciliationWriteError(snapshot.organizationId);
      }

      const drift = Math.abs(currentCount - snapshot.billableCount);
      try {
        await this.counterPort.overwrite({
          organizationId: snapshot.organizationId,
          month: target.month,
          count: snapshot.billableCount,
        });
      } catch {
        emit({
          type: 'failed',
          organizationId: snapshot.organizationId,
          month: target.month,
          reconciled,
          overQuota,
          driftedOrganizations: driftedCount,
          driftRequests,
          failed: 1,
        });
        throw new QuotaReconciliationWriteError(snapshot.organizationId);
      }

      if (snapshot.overQuota) {
        overQuota += 1;
      }
      if (drift > 0) {
        driftedCount += 1;
        driftRequests += drift;
      }
      reconciled += 1;
      emit({
        type: 'reconciled',
        result: { ...snapshot, month: target.month },
      });
    }

    const summary = {
      reconciled,
      overQuota,
      driftedOrganizations: driftedCount,
      driftRequests,
      failed: 0,
    } as const;
    emit({ type: 'summary', month: target.month, summary });
    return summary;
  }
}
