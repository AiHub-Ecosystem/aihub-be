export const BASELINE = {
  defaultAdminUrl: 'postgres://aihub:change-me@localhost:5432/aihub',
  databaseLaneLockKey: [0x41494842, 0x44424c4e] as const,
  organizationCount: 100,
  apiKeyCount: 100_000,
  userCount: 1_000,
  membershipCount: 100_000,
  usageRecordCount: 1_000_000,
  idempotencyRecordCount: 100_000,
  dispatchAttemptCount: 100_000,
  sandboxReservationCount: 100_000,
  retentionBatchSize: 500,
  retentionDays: 30,
  retentionSpanSeconds: 210 * 24 * 60 * 60,
} as const;

export const TARGET_ORGANIZATION_ID = `bench_org_${String(
  BASELINE.organizationCount - 1,
).padStart(3, '0')}`;
export const TARGET_USER_ID = `usr_${String(1).padStart(26, '0')}`;
