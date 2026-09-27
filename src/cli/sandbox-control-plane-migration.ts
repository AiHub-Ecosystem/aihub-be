import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const TABLES = [
  { name: 'organizations', key: 'id' },
  { name: 'api_keys', key: 'id' },
  { name: 'organization_identity_configs', key: 'organization_id' },
] as const;
const DEPENDENCIES = [
  'organization_members',
  'organization_invitations',
  'organization_audit_events',
] as const;

export interface SandboxMigrationResult {
  readonly status: 'dry_run' | 'applied' | 'already_migrated';
  readonly organizations: number;
  readonly apiKeys: number;
  readonly identityConfigs: number;
}

type Row = Record<string, unknown>;

function stable(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Buffer.isBuffer(value)) {
    return JSON.stringify(value.toString('hex'));
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameRow(left: Row, right: Row): boolean {
  return stable(left) === stable(right);
}

async function dependencyCounts(
  client: PoolClient,
  organizationId: string,
): Promise<readonly { table: string; count: number }[]> {
  const counts = [];
  for (const table of DEPENDENCIES) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`,
      [organizationId],
    );
    counts.push({ table, count: Number(result.rows[0]?.count ?? 0) });
  }
  return counts;
}

async function assertNoDependencies(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  const populated = (await dependencyCounts(client, organizationId)).filter(
    ({ count }) => count > 0,
  );
  if (populated.length > 0) {
    throw new Error(
      `sandbox Organization has dependent control-plane records (${populated.map(({ table, count }) => `${table}:${count}`).join(', ')}); resolve them before migration`,
    );
  }
}

async function rowsForOrganization(
  client: PoolClient,
  table: (typeof TABLES)[number],
  organizationId: string,
): Promise<Row[]> {
  const result = await client.query<QueryResultRow>(
    `SELECT * FROM ${table.name} WHERE ${table.name === 'organizations' ? 'id' : 'organization_id'} = $1 ORDER BY ${table.key}`,
    [organizationId],
  );
  return result.rows as Row[];
}

async function insertRow(
  client: PoolClient,
  table: (typeof TABLES)[number],
  row: Row,
): Promise<void> {
  const columns = Object.keys(row);
  if (columns.some((column) => !/^[a-z_]+$/.test(column))) {
    throw new Error('sandbox migration encountered an invalid database column');
  }
  const names = columns.map((column) => `"${column}"`).join(', ');
  const parameters = columns.map((_, index) => `$${index + 1}`).join(', ');
  await client.query(
    `INSERT INTO ${table.name} (${names}) VALUES (${parameters})`,
    columns.map((column) => row[column]),
  );
}

function rowsForTarget(
  table: (typeof TABLES)[number],
  rows: readonly Row[],
): Row[] {
  return table.name === 'api_keys'
    ? rows.map((row) => ({ ...row, allowed_environments: ['sandbox'] }))
    : [...rows];
}

export async function migrateSandboxOrganization(
  source: Pool,
  target: Pool,
  organizationId: string,
  apply: boolean,
): Promise<SandboxMigrationResult> {
  if (!/^org_[A-Za-z0-9_-]{1,128}$/.test(organizationId)) {
    throw new Error('--org must be a valid Organization id');
  }

  const sourceClient = await source.connect();
  const targetClient = await target.connect();
  try {
    await assertNoDependencies(sourceClient, organizationId);
    const sourceRows = new Map<(typeof TABLES)[number]['name'], Row[]>();
    for (const table of TABLES) {
      sourceRows.set(
        table.name,
        await rowsForOrganization(sourceClient, table, organizationId),
      );
    }
    const organizations = sourceRows.get('organizations') ?? [];
    const apiKeys = sourceRows.get('api_keys') ?? [];
    const identityConfigs =
      sourceRows.get('organization_identity_configs') ?? [];
    const targetExpected = new Map<(typeof TABLES)[number]['name'], Row[]>();
    for (const table of TABLES) {
      targetExpected.set(
        table.name,
        rowsForTarget(table, sourceRows.get(table.name) ?? []),
      );
    }

    if (organizations.length === 0) {
      const targetOrganizations = await rowsForOrganization(
        targetClient,
        TABLES[0],
        organizationId,
      );
      const targetKeys = await rowsForOrganization(
        targetClient,
        TABLES[1],
        organizationId,
      );
      const targetConfigs = await rowsForOrganization(
        targetClient,
        TABLES[2],
        organizationId,
      );
      if (
        targetOrganizations.length === 1 &&
        targetKeys.length > 0 &&
        targetConfigs.length === 1
      ) {
        return {
          status: 'already_migrated',
          organizations: 1,
          apiKeys: targetKeys.length,
          identityConfigs: 1,
        };
      }
      throw new Error(
        'sandbox Organization is missing from the source database',
      );
    }
    if (
      organizations.length !== 1 ||
      apiKeys.length === 0 ||
      identityConfigs.length !== 1
    ) {
      throw new Error(
        'sandbox Organization must have one Organization row, at least one API key, and one identity configuration',
      );
    }

    const targetRows = new Map<(typeof TABLES)[number]['name'], Row[]>();
    for (const table of TABLES) {
      targetRows.set(
        table.name,
        await rowsForOrganization(targetClient, table, organizationId),
      );
    }
    for (const table of TABLES) {
      const expected = targetExpected.get(table.name) ?? [];
      const existing = targetRows.get(table.name) ?? [];
      for (const row of existing) {
        const sourceMatch = expected.find((candidate) =>
          sameRow(candidate, row),
        );
        if (sourceMatch === undefined) {
          throw new Error(
            `production control plane contains conflicting ${table.name} data for this Organization`,
          );
        }
      }
      for (const row of expected) {
        const existingMatch = existing.find((candidate) =>
          sameRow(candidate, row),
        );
        if (
          existingMatch === undefined &&
          expected.length === existing.length
        ) {
          throw new Error(
            `production control plane contains conflicting ${table.name} data for this Organization`,
          );
        }
      }
    }

    if (!apply) {
      return {
        status: 'dry_run',
        organizations: organizations.length,
        apiKeys: apiKeys.length,
        identityConfigs: identityConfigs.length,
      };
    }

    await targetClient.query('BEGIN');
    try {
      for (const table of TABLES) {
        const expected = targetExpected.get(table.name) ?? [];
        const existing = targetRows.get(table.name) ?? [];
        for (const row of expected) {
          if (!existing.some((candidate) => sameRow(candidate, row))) {
            await insertRow(targetClient, table, row);
          }
        }
      }
      await targetClient.query('COMMIT');
    } catch (error) {
      await targetClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    await sourceClient.query('BEGIN');
    try {
      await sourceClient.query(
        'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
        [organizationId],
      );
      await assertNoDependencies(sourceClient, organizationId);
      for (const table of TABLES) {
        const currentRows = await rowsForOrganization(
          sourceClient,
          table,
          organizationId,
        );
        const expectedRows = sourceRows.get(table.name) ?? [];
        if (
          currentRows.length !== expectedRows.length ||
          currentRows.some(
            (row, index) => !sameRow(row, expectedRows[index] ?? {}),
          )
        ) {
          throw new Error(
            'sandbox control-plane data changed during migration; source data was left in place',
          );
        }
      }
      for (const table of [...TABLES].reverse()) {
        await sourceClient.query(
          `DELETE FROM ${table.name} WHERE ${table.name === 'organizations' ? 'id' : 'organization_id'} = $1`,
          [organizationId],
        );
      }
      await sourceClient.query('COMMIT');
    } catch (error) {
      await sourceClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    return {
      status: 'applied',
      organizations: organizations.length,
      apiKeys: apiKeys.length,
      identityConfigs: identityConfigs.length,
    };
  } finally {
    sourceClient.release();
    targetClient.release();
  }
}

export interface RunSandboxMigrationInput {
  readonly argv: readonly string[];
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly emit?: (line: string) => void;
}

export async function runSandboxControlPlaneMigrationCli(
  input: RunSandboxMigrationInput,
): Promise<SandboxMigrationResult> {
  const orgIndex = input.argv.indexOf('--org');
  const organizationId = input.argv[orgIndex + 1]?.trim();
  if (
    orgIndex < 0 ||
    organizationId === undefined ||
    organizationId.length === 0
  ) {
    throw new Error('missing required option --org');
  }
  const apply = input.argv.includes('--apply');
  const unsupported = input.argv.filter(
    (argument, index) =>
      argument !== '--apply' &&
      !(argument === '--org' || index === orgIndex + 1),
  );
  if (unsupported.length > 0) {
    throw new Error(`unsupported option ${unsupported[0]}`);
  }

  if (
    input.sourceUrl.trim().length === 0 ||
    input.targetUrl.trim().length === 0
  ) {
    throw new Error('DATABASE_URL and CONTROL_PLANE_DATABASE_URL are required');
  }
  const sourceName = new URL(input.sourceUrl).pathname.slice(1).toLowerCase();
  const targetName = new URL(input.targetUrl).pathname.slice(1).toLowerCase();
  if (
    !sourceName.includes('sandbox') ||
    targetName.includes('sandbox') ||
    input.sourceUrl === input.targetUrl
  ) {
    throw new Error(
      'DATABASE_URL must name the Sandbox database and CONTROL_PLANE_DATABASE_URL the production control-plane database',
    );
  }

  const source = new Pool({ connectionString: input.sourceUrl, max: 2 });
  const target = new Pool({ connectionString: input.targetUrl, max: 2 });
  try {
    const result = await migrateSandboxOrganization(
      source,
      target,
      organizationId,
      apply,
    );
    (input.emit ?? console.log)(
      `${result.status}: Organizations=${result.organizations}, API keys=${result.apiKeys}, identity configs=${result.identityConfigs}; Sandbox usage and idempotency stay in place.`,
    );
    return result;
  } finally {
    await source.end();
    await target.end();
  }
}
