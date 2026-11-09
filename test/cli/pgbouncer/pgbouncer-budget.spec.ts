import { validatePgBouncerBundle } from '../../../ops/vault/pgbouncer-budget.mjs';

function applicationBudget(application: string) {
  return {
    application,
    host: 'db.example.invalid',
    port: 5432,
    database: 'aihub',
    max_db_connections: 4,
    max_db_client_connections: 6,
    client_pool_max: 2,
    max_process_overlap: 3,
    approved_by: 'fixture-owner',
    evidence: 'fixture application cap',
    approved_at: '2026-11-01',
    users: [
      {
        username: `user_${application}`,
        password: `fixture-${application}-password`,
      },
    ],
  };
}

function approvedBundle() {
  return {
    max_connections: 100,
    max_connections_evidence: 'fixture cluster snapshot',
    max_connections_measured_at: '2026-11-01',
    reserved_slots: 3,
    reserved_slots_evidence: 'fixture cluster snapshot',
    reserved_slots_measured_at: '2026-11-01',
    operational_headroom: 5,
    headroom_approved_by: 'fixture-owner',
    headroom_evidence: 'fixture approval',
    headroom_approved_at: '2026-11-01',
    cluster_client_inventory_approved_by: 'fixture-owner',
    cluster_client_inventory_evidence: 'fixture complete client inventory',
    cluster_client_inventory_approved_at: '2026-11-01',
    capacity_evidence_valid_through: new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10),
    max_client_conn: 32,
    admin_password: 'fixture-admin-password',
    stats_password: 'fixture-stats-password',
    direct_clients: [
      {
        name: 'speaking_app',
        pool_max: 2,
        process_overlap: 1,
        approved_by: 'fixture-owner',
        evidence: 'fixture direct-client cap',
        approved_at: '2026-11-01',
      },
    ],
    databases: {
      aihub_be: applicationBudget('aihub-be'),
      aihub_be_read: applicationBudget('aihub-be'),
      ai_writing: applicationBudget('ai-writing'),
      ai_speaking: applicationBudget('ai-speaking'),
      ai_portal: applicationBudget('ai-portal'),
    },
  };
}

describe('PgBouncer Vault budget bundle', () => {
  it('accepts a complete approved client and backend budget', () => {
    expect(() => validatePgBouncerBundle(approvedBundle(), 4)).not.toThrow();
  });

  it('rejects backend caps that exceed the measured PostgreSQL budget', () => {
    const bundle = approvedBundle();
    for (const alias of [
      'aihub_be',
      'aihub_be_read',
      'ai_writing',
      'ai_speaking',
      'ai_portal',
    ] as const) {
      bundle.databases[alias] = {
        ...bundle.databases[alias]!,
        max_db_connections: 30,
        max_db_client_connections: 30,
        client_pool_max: 10,
      };
    }
    bundle.max_client_conn = 152;

    expect(() => validatePgBouncerBundle(bundle, 20)).toThrow(
      'backend, direct, and headroom caps exceed PostgreSQL capacity',
    );
  });

  it('rejects app-client overlap above the PgBouncer client cap', () => {
    const bundle = approvedBundle();
    bundle.max_client_conn = 31;

    expect(() => validatePgBouncerBundle(bundle, 4)).toThrow(
      'max_client_conn must cover approved aliases plus admin and metrics',
    );
  });

  it('keeps max_connections at 100 without a separate approved change', () => {
    const bundle = approvedBundle();
    bundle.max_connections = 101;

    expect(() => validatePgBouncerBundle(bundle, 4)).toThrow(
      'max_connections must remain 100 until separately approved',
    );
  });

  it('requires all application budgets and owner approval of the full inventory', () => {
    const bundle = approvedBundle();
    bundle.databases.ai_portal = {
      ...bundle.databases.ai_portal,
      application: 'aihub-be',
    };
    expect(() => validatePgBouncerBundle(bundle, 4)).toThrow(
      'all four AIHUB application budgets are required',
    );

    const missingInventoryApproval = approvedBundle();
    missingInventoryApproval.cluster_client_inventory_evidence = '';
    expect(() => validatePgBouncerBundle(missingInventoryApproval, 4)).toThrow(
      'capacity evidence is required',
    );

    const expiredEvidence = approvedBundle();
    expiredEvidence.capacity_evidence_valid_through = '2000-01-01';
    expect(() => validatePgBouncerBundle(expiredEvidence, 4)).toThrow(
      'capacity evidence is expired',
    );
  });

  it('allows one application credential across its aliases but not across apps', () => {
    const bundle = approvedBundle();
    expect(() => validatePgBouncerBundle(bundle, 4)).not.toThrow();

    const sharedApplicationCredential = approvedBundle();
    sharedApplicationCredential.databases.aihub_be_read = {
      ...sharedApplicationCredential.databases.aihub_be_read!,
      users: [
        {
          ...sharedApplicationCredential.databases.aihub_be_read!.users[0]!,
          ...sharedApplicationCredential.databases.aihub_be!.users[0]!,
        },
      ],
    };
    expect(() =>
      validatePgBouncerBundle(sharedApplicationCredential, 4),
    ).not.toThrow();

    const conflictingPassword = approvedBundle();
    conflictingPassword.databases.aihub_be_read = {
      ...conflictingPassword.databases.aihub_be_read!,
      users: [
        {
          ...conflictingPassword.databases.aihub_be_read!.users[0]!,
          username: conflictingPassword.databases.aihub_be!.users[0]!.username,
          password: 'different-fixture-password',
        },
      ],
    };
    expect(() => validatePgBouncerBundle(conflictingPassword, 4)).toThrow(
      'PgBouncer aliases must reuse the same application credential',
    );

    bundle.databases.ai_portal = {
      ...bundle.databases.ai_portal!,
      users: [
        {
          ...bundle.databases.ai_portal!.users[0]!,
          username: bundle.databases.aihub_be!.users[0]!.username,
        },
      ],
    };
    expect(() => validatePgBouncerBundle(bundle, 4)).toThrow(
      'PgBouncer application credentials must be separate',
    );
  });

  it('rejects runtime pool caps that do not match the AIHUB alias budget', () => {
    expect(() => validatePgBouncerBundle(approvedBundle(), 5)).toThrow(
      'AIHUB runtime pool caps must match the approved PgBouncer aliases',
    );
  });
});
