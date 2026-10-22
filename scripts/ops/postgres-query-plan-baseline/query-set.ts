import {
  IDEMPOTENCY_COMPLETED_REPLAY_SQL,
  IDEMPOTENCY_INSERT_SQL,
  IDEMPOTENCY_RESERVATION_READ_SQL,
  IDEMPOTENCY_RETENTION_CLEANUP_SQL,
} from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { API_KEY_LOOKUP_SQL } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import {
  LIST_ORGANIZATION_MEMBERS_SQL,
  LIST_ROSTER_SQL,
  RESOLVE_MEMBERSHIP_SQL,
} from '@/modules/identity/membership/infrastructure/postgres-organization-membership.repository';
import { BILLING_USAGE_SQL } from '@/modules/metering/infrastructure/postgres-billing-statement.repository';
import { QUOTA_RECONCILIATION_SQL } from '@/modules/metering/infrastructure/postgres-quota-reconciliation.repository';
import { USAGE_REPORT_SQL } from '@/modules/metering/infrastructure/postgres-usage-completeness-report.repository';
import {
  DISPATCH_ATTEMPT_RETENTION_BATCH_SQL,
  USAGE_RETENTION_BATCH_SQL,
} from '@/modules/metering/infrastructure/postgres-usage-retention.repository';

import { BASELINE, TARGET_ORGANIZATION_ID, TARGET_USER_ID } from './config';
import type { BaselineQuery } from './types';

const LOOKUP_HASH = Buffer.alloc(32);
LOOKUP_HASH.writeBigUInt64BE(BigInt(BASELINE.apiKeyCount), 24);

// Keep aligned with the metering aggregate in benchmark-control-plane.mjs.
const REQUEST_TOKEN_AGGREGATE_SQL = `
  SELECT
    COALESCE(SUM(billable_requests) FILTER (WHERE outcome = 'success'), 0)::bigint AS billable_request_count,
    COALESCE(SUM(total_tokens) FILTER (WHERE outcome = 'success' AND billable_requests = 1), 0)::bigint AS billable_token_count,
    COUNT(*) FILTER (WHERE outcome = 'success' AND metering_status = 'missing_usage')::bigint AS missing_usage_count
  FROM usage_records
  WHERE organization_id = $1
    AND created_at >= $2
    AND created_at < $3
    AND ($4::text IS NULL OR operation = $4)
`;

function monthBounds(now: Date): { readonly from: Date; readonly to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    from,
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function fingerprintHex(value: number): string {
  const fingerprint = Buffer.alloc(32);
  fingerprint.writeBigUInt64BE(BigInt(value), 24);
  return fingerprint.toString('hex');
}

export function baselineQueries(now: Date): readonly BaselineQuery[] {
  const { from, to } = monthBounds(now);
  const cutoff = new Date(
    now.getTime() - BASELINE.retentionDays * 24 * 60 * 60 * 1000,
  );
  const fingerprint = fingerprintHex(BASELINE.idempotencyRecordCount);
  const organizationId = TARGET_ORGANIZATION_ID;
  const idempotencyParameters = [
    organizationId,
    'writing.task2.grade',
    'baseline',
    'baseline-conflict',
  ];
  const monthStart = from.toISOString().slice(0, 10);

  return [
    {
      name: 'API-key lookup by hash',
      sql: API_KEY_LOOKUP_SQL,
      parameters: [LOOKUP_HASH],
      tables: ['api_keys', 'organizations'],
      expectedIndexes: ['api_keys_hash_uq'],
      expectedSeqScanTables: ['organizations'],
    },
    {
      name: 'Organization read by primary key',
      sql: 'SELECT id, status, entitlements, monthly_request_quota FROM organizations WHERE id = $1',
      parameters: [organizationId],
      tables: ['organizations'],
      expectedIndexes: [],
      expectedSeqScanTables: ['organizations'],
    },
    {
      name: 'Membership resolution',
      sql: RESOLVE_MEMBERSHIP_SQL,
      parameters: [TARGET_USER_ID, organizationId],
      tables: ['organization_members', 'organizations'],
      expectedIndexes: ['organization_members_pkey'],
      expectedSeqScanTables: ['organizations'],
    },
    {
      name: 'Membership roster for caller',
      sql: LIST_ROSTER_SQL,
      parameters: [TARGET_USER_ID],
      tables: [
        'organization_members',
        'organizations',
        'organization_identity_configs',
        'user_accounts',
      ],
      expectedIndexes: [
        'organization_members_user_account_idx',
        'organization_members_pkey',
        'user_accounts_pkey',
      ],
      expectedSeqScanTables: ['organization_identity_configs', 'organizations'],
    },
    {
      name: 'Organization membership list',
      sql: LIST_ORGANIZATION_MEMBERS_SQL,
      parameters: [
        organizationId,
        TARGET_USER_ID,
        ['owner', 'admin'],
        'active',
      ],
      tables: ['organization_members', 'organizations', 'user_accounts'],
      expectedIndexes: ['organization_members_pkey'],
      expectedSeqScanTables: ['organizations', 'user_accounts'],
    },
    {
      name: 'Idempotency conflicting reservation insert',
      sql: IDEMPOTENCY_INSERT_SQL,
      parameters: [
        ...idempotencyParameters,
        fingerprint,
        'bench_conflict_probe',
        new Date(now.getTime() + 24 * 60 * 60 * 1000),
      ],
      tables: ['idempotency_records'],
      expectedIndexes: ['idempotency_records_scope_key'],
      mutates: true,
    },
    {
      name: 'Idempotency reservation read after conflict',
      sql: IDEMPOTENCY_RESERVATION_READ_SQL,
      parameters: idempotencyParameters,
      tables: ['idempotency_records'],
      expectedIndexes: ['idempotency_records_scope_key'],
    },
    {
      name: 'Completed idempotency replay read',
      sql: IDEMPOTENCY_COMPLETED_REPLAY_SQL,
      parameters: [...idempotencyParameters, fingerprint],
      tables: ['idempotency_records'],
      expectedIndexes: ['idempotency_records_scope_key'],
    },
    {
      name: 'Sandbox allowance override read',
      sql: 'SELECT allowance FROM sandbox_allowance_overrides WHERE organization_id = $1 AND month_start = $2::date',
      parameters: [organizationId, monthStart],
      tables: ['sandbox_allowance_overrides'],
      expectedIndexes: ['sandbox_allowance_overrides_pkey'],
    },
    {
      name: 'Sandbox allowance default read',
      sql: 'SELECT allowance FROM sandbox_allowance_defaults WHERE month_start <= $1::date ORDER BY month_start DESC LIMIT 1',
      parameters: [monthStart],
      tables: ['sandbox_allowance_defaults'],
      expectedIndexes: ['sandbox_allowance_defaults_pkey'],
    },
    {
      name: 'Sandbox reservation count by Organization',
      sql: "SELECT count(*) FROM sandbox_dispatch_reservations WHERE status = 'reserved' AND month_start = $1::date AND organization_id = $2",
      parameters: [monthStart, organizationId],
      tables: ['sandbox_dispatch_reservations'],
      expectedIndexes: ['sandbox_dispatch_reservations_month_idx'],
    },
    {
      name: 'Sandbox reservation count by Environment',
      sql: "SELECT count(*) FROM sandbox_dispatch_reservations WHERE status = 'reserved' AND month_start = $1::date",
      parameters: [monthStart],
      tables: ['sandbox_dispatch_reservations'],
      expectedIndexes: [],
      expectedSeqScanTables: ['sandbox_dispatch_reservations'],
    },
    {
      name: 'Request and token metering aggregate',
      sql: REQUEST_TOKEN_AGGREGATE_SQL,
      parameters: [organizationId, from, to, null],
      tables: ['usage_records'],
      expectedIndexes: ['usage_org_time_idx'],
    },
    {
      name: 'Metering usage completeness aggregate',
      sql: USAGE_REPORT_SQL,
      parameters: [
        from,
        to,
        [
          'writing.task1.grade',
          'writing.task2.grade',
          'speaking.grade',
          'speaking.grade-json',
        ],
      ],
      tables: ['usage_records'],
      expectedIndexes: ['usage_created_brin'],
    },
    {
      name: 'Monthly quota reconciliation aggregate',
      sql: QUOTA_RECONCILIATION_SQL,
      parameters: [from, to],
      tables: ['organizations', 'usage_records'],
      expectedIndexes: ['usage_created_brin'],
      expectedSeqScanTables: ['organizations'],
    },
    {
      name: 'Monthly billing aggregate',
      sql: BILLING_USAGE_SQL,
      parameters: [from, to, null],
      tables: ['usage_records', 'api_keys'],
      expectedIndexes: ['usage_created_brin'],
      expectedSeqScanTables: ['api_keys'],
    },
    {
      name: 'Usage-record retention batch',
      sql: USAGE_RETENTION_BATCH_SQL,
      parameters: [cutoff, null, null, BASELINE.retentionBatchSize],
      tables: ['usage_records'],
      expectedIndexes: ['usage_created_brin', 'usage_records_pkey'],
      mutates: true,
    },
    {
      name: 'Dispatch-attempt retention batch',
      sql: DISPATCH_ATTEMPT_RETENTION_BATCH_SQL,
      parameters: [cutoff, BASELINE.retentionBatchSize],
      tables: ['dispatch_attempts'],
      expectedIndexes: [
        'dispatch_attempts_retention_idx',
        'dispatch_attempts_pkey',
      ],
      mutates: true,
    },
    {
      name: 'Expired idempotency cleanup',
      sql: IDEMPOTENCY_RETENTION_CLEANUP_SQL,
      parameters: [],
      tables: ['idempotency_records'],
      expectedIndexes: ['idempotency_records_expires_idx'],
      mutates: true,
    },
  ];
}
