import type { PrismaClient } from '@prisma-client/client';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type {
  WritingChartRevocationAuditRecord,
  WritingChartRevocationAuditRepositoryPort,
} from '@/modules/writing/application/writing-chart-revocation.port';
import {
  WRITING_CHART_LOCK_SQL,
  writingChartPublicationLockKey,
} from './postgres-writing-chart-upload.repository';

export const WRITING_CHART_REVOCATION_AUDIT_PRUNE_SQL = `
  WITH candidates AS (
    SELECT id
    FROM writing_chart_revocation_audits
    WHERE occurred_at < $1
    ORDER BY occurred_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM writing_chart_revocation_audits AS audit
  USING candidates
  WHERE audit.id = candidates.id
  RETURNING audit.id
`;

const nextAuditId = prefixedIdGenerator('wra_');

function auditData(record: WritingChartRevocationAuditRecord) {
  return {
    id: nextAuditId(record.occurredAt),
    assetId: record.assetId,
    actorUserAccountId: record.actorUserAccountId,
    occurredAt: record.occurredAt,
    phase: record.phase,
    originOutcome: record.originOutcome,
    edgeOutcome: record.edgeOutcome,
    edgeStatus: record.edgeStatus,
  };
}

export class PostgresWritingChartRevocationAuditRepository
  implements WritingChartRevocationAuditRepositoryPort
{
  constructor(private readonly client: PrismaClient) {}

  async findActiveOperatorAccount(
    username: string,
  ): Promise<string | undefined> {
    const account = await this.client.userAccount.findFirst({
      where: { username, status: 'active' },
      select: { id: true },
    });
    return account?.id;
  }

  async requestRevocation(
    record: Extract<WritingChartRevocationAuditRecord, { phase: 'requested' }>,
    publishingSince: Date,
  ): Promise<{ readonly publicationPending: boolean }> {
    return this.client.$transaction(async (transaction) => {
      const upload = await transaction.writingChartUpload.findUnique({
        where: { id: record.assetId },
        select: { organizationId: true },
      });
      // A pruned row has no publisher left to fence; #816 deletes by key.
      if (upload !== null) {
        await transaction.$executeRawUnsafe(
          WRITING_CHART_LOCK_SQL,
          writingChartPublicationLockKey(upload.organizationId),
        );
      }
      await transaction.writingChartRevocationAudit.create({
        data: auditData(record),
      });
      const current =
        upload === null
          ? null
          : await transaction.writingChartUpload.findUnique({
              where: { id: record.assetId },
              select: { status: true, publicationStartedAt: true },
            });
      return {
        publicationPending:
          current?.status === 'publishing' &&
          current.publicationStartedAt !== null &&
          current.publicationStartedAt > publishingSince,
      };
    });
  }

  async append(record: WritingChartRevocationAuditRecord): Promise<void> {
    await this.client.writingChartRevocationAudit.create({
      data: auditData(record),
    });
  }

  async pruneExpired(cutoff: Date, batchSize: number): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<readonly { id: string }[]>(
      WRITING_CHART_REVOCATION_AUDIT_PRUNE_SQL,
      cutoff,
      batchSize,
    );
    return rows.length;
  }
}
