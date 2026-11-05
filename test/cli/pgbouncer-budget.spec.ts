import { validatePgBouncerBundle } from '../../ops/vault/pgbouncer-budget.mjs';

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
    max_client_conn: 26,
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
    databases: Object.fromEntries(
      ['aihub_be', 'ai_writing', 'ai_speaking', 'ai_portal'].map((alias) => [
        alias,
        {
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
              username: `user_${alias}`,
              password: `fixture-${alias}-password`,
            },
          ],
        },
      ]),
    ),
  };
}

describe('PgBouncer Vault budget bundle', () => {
  it('accepts a complete approved client and backend budget', () => {
    expect(() => validatePgBouncerBundle(approvedBundle())).not.toThrow();
  });

  it('rejects backend caps that exceed the measured PostgreSQL budget', () => {
    const bundle = approvedBundle();
    for (const database of Object.values(bundle.databases)) {
      database.max_db_connections = 30;
      database.max_db_client_connections = 30;
      database.client_pool_max = 10;
    }
    bundle.max_client_conn = 122;

    expect(() => validatePgBouncerBundle(bundle)).toThrow(
      'backend, direct, and headroom caps exceed PostgreSQL capacity',
    );
  });

  it('rejects app-client overlap above the PgBouncer client cap', () => {
    const bundle = approvedBundle();
    bundle.max_client_conn = 25;

    expect(() => validatePgBouncerBundle(bundle)).toThrow(
      'max_client_conn must cover approved aliases plus admin and metrics',
    );
  });

  it('keeps max_connections at 100 without a separate approved change', () => {
    const bundle = approvedBundle();
    bundle.max_connections = 101;

    expect(() => validatePgBouncerBundle(bundle)).toThrow(
      'max_connections must remain 100 until separately approved',
    );
  });

  it('requires a different Vault credential for each database alias', () => {
    const bundle = approvedBundle();
    bundle.databases.ai_portal!.users[0]!.username =
      bundle.databases.ai_writing!.users[0]!.username;

    expect(() => validatePgBouncerBundle(bundle)).toThrow(
      'database aliases must use separate credentials',
    );
  });
});
