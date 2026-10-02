import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ulid } from 'ulid';

import { Argon2PasswordHasher } from '@/modules/auth/infrastructure/argon2-password.hasher';
import type { PostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-api-key.repository';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import {
  type Disposition,
  type MigrationExport,
  type MigrationOutcome,
  type MigrationPorts,
  runCustomerWebMigrationCommand,
} from './customer-web-migration';

/**
 * The Clerk export file is deliberately ours, not Clerk's: without a captured
 * Clerk fixture the runner must not invent a provider response shape, so it
 * reads a normalized document the operator produces from the Clerk console or
 * Backend API (see the runbook). Every row is validated here — an unclear
 * row fails the run naming the field, never silently.
 *
 * ```json
 * {
 *   "users": [{ "clerkUserId": "user_abc", "email": "a@example.com", "membership": "active" }],
 *   "invitations": [{ "email": "b@example.com", "role": "member" }]
 * }
 * ```
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMembershipStatus(
  value: unknown,
  path: string,
): 'active' | 'disabled' {
  if (value === 'active' || value === 'disabled') return value;
  throw new Error(`export file ${path} must be "active" or "disabled"`);
}

function parseRole(value: unknown, path: string): 'owner' | 'admin' | 'member' {
  if (value === 'owner' || value === 'admin' || value === 'member')
    return value;
  throw new Error(`export file ${path} must be "owner", "admin", or "member"`);
}

export function parseMigrationExportFile(text: string): MigrationExport {
  const root = asRecord(JSON.parse(text) as unknown);
  const rawUsers = root?.['users'];
  const rawInvitations = root?.['invitations'];
  if (!Array.isArray(rawUsers) || !Array.isArray(rawInvitations)) {
    throw new Error(
      'export file must be a JSON object with "users" and "invitations"',
    );
  }
  const clerkUsers = rawUsers.map((entry, index) => {
    const record = asRecord(entry);
    const clerkUserId =
      record !== null && typeof record['clerkUserId'] === 'string'
        ? (record['clerkUserId'] as string).trim()
        : '';
    if (clerkUserId.length === 0) {
      throw new Error(
        `export file users[${String(index)}].clerkUserId must be a non-empty string`,
      );
    }
    const email = record?.['email'] ?? null;
    if (email !== null && typeof email !== 'string') {
      throw new Error(
        `export file users[${String(index)}].email must be a string or null`,
      );
    }
    return {
      clerkUserId,
      email: typeof email === 'string' ? email : null,
      membershipStatus: parseMembershipStatus(
        record?.['membership'],
        `users[${String(index)}].membership`,
      ),
    };
  });
  const clerkInvitations = rawInvitations.map((entry, index) => {
    const record = asRecord(entry);
    if (record === null || typeof record['email'] !== 'string') {
      throw new Error(
        `export file invitations[${String(index)}].email must be a string`,
      );
    }
    return {
      email: record['email'] as string,
      role: parseRole(record['role'], `invitations[${String(index)}].role`),
    };
  });
  return { clerkUsers, clerkInvitations };
}

export function parseDispositionsFile(
  text: string,
): Record<string, Disposition> {
  const root = asRecord(JSON.parse(text) as unknown);
  if (root === null) {
    throw new Error(
      'dispositions file must be a JSON object keyed by Clerk user id',
    );
  }
  const dispositions: Record<string, Disposition> = {};
  for (const [clerkUserId, entry] of Object.entries(root)) {
    const record = asRecord(entry);
    const kind = record?.['kind'];
    if (kind === 'skip') {
      dispositions[clerkUserId] = { kind: 'skip' };
      continue;
    }
    if (kind === 'create') {
      dispositions[clerkUserId] = { kind: 'create' };
      continue;
    }
    if (kind === 'link' && typeof record?.['accountId'] === 'string') {
      dispositions[clerkUserId] = {
        kind: 'link',
        accountId: record['accountId'] as string,
      };
      continue;
    }
    throw new Error(
      `dispositions file "${clerkUserId}" must be {"kind":"link","accountId":"..."}, {"kind":"create"}, or {"kind":"skip"}`,
    );
  }
  return dispositions;
}

export interface DatabaseMigrationPortsInput {
  readonly client: PostgresIdentityClient & PostgresIdentityTransactionalClient;
  readonly organizationId: string;
}

/**
 * Real Postgres ports for the executor. Account creation reuses exactly the
 * `user_accounts` / `auth_identities` shape that registration owns (active
 * status, Argon2id hash of a random value whose plaintext is discarded —
 * nobody can log in until the reset-password path sets a real credential),
 * and membership writes use insert-or-update on the table's own primary key
 * so a rerun converges instead of conflicting.
 */
export function createDatabaseMigrationPorts(
  input: DatabaseMigrationPortsInput,
): MigrationPorts {
  const { client, organizationId } = input;
  const hasher = new Argon2PasswordHasher();

  return {
    loadState: async () => {
      const accountRows = (await client.query(
        `SELECT a.id AS account_id, i.canonical_email AS email, a.status AS status
         FROM user_accounts AS a
         JOIN auth_identities AS i ON i.user_account_id = a.id
         WHERE i.provider = 'password'`,
        [],
      )) as readonly Record<string, unknown>[];
      const membershipRows = (await client.query(
        `SELECT user_account_id AS account_id, role AS role, status AS status
         FROM organization_members
         WHERE organization_id = $1`,
        [organizationId],
      )) as readonly Record<string, unknown>[];
      const usernameRows = (await client.query(
        `SELECT username AS username FROM user_accounts`,
        [],
      )) as readonly Record<string, unknown>[];
      return {
        existingAccounts: accountRows.map((row) => ({
          accountId: String(row['account_id']),
          canonicalEmail: String(row['email']),
          status: String(row['status']) as
            | 'pending_verification'
            | 'active'
            | 'disabled',
        })),
        existingMemberships: membershipRows.map((row) => ({
          accountId: String(row['account_id']),
          role: String(row['role']) as 'owner' | 'admin' | 'member',
          status: String(row['status']) as 'active' | 'disabled',
        })),
        takenUsernames: new Set(
          usernameRows.map((row) => String(row['username'])),
        ),
      };
    },
    createAccount: async (account) => {
      const identityId = `auth_${ulid()}`;
      await client.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
           VALUES ($1, $2, 'active', now(), now())`,
          [account.accountId, account.username],
        );
        await tx.query(
          `INSERT INTO auth_identities
             (id, user_account_id, provider, canonical_email, password_hash, created_at, updated_at)
           VALUES ($1, $2, 'password', $3, $4, now(), now())`,
          [identityId, account.accountId, account.email, account.passwordHash],
        );
      });
      return account.accountId;
    },
    upsertMembership: async (membership) => {
      await client.query(
        `INSERT INTO organization_members
           (organization_id, user_account_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (organization_id, user_account_id)
         DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = now()`,
        [
          organizationId,
          membership.accountId,
          membership.role,
          membership.status,
        ],
      );
    },
    hashPassword: async () => hasher.hash(randomBytes(32).toString('hex')),
    writeEvidence: async (text: string) => {
      throw new Error(
        `evidence sink not wired (would write ${String(text.length)} bytes)`,
      );
    },
    emit: (line: string) => console.log(line),
  };
}

export interface RunMigrationCliInput {
  readonly argv: readonly string[];
  readonly databaseUrl: string;
  readonly evidenceOut?: (text: string, evidencePath: string) => Promise<void>;
  readonly emit?: (line: string) => void;
  readonly createClient?: (
    databaseUrl: string,
  ) => PostgresIdentityClient & PostgresIdentityTransactionalClient;
}

function readOption(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === name && index + 1 < argv.length) {
      return argv[index + 1];
    }
  }
  return undefined;
}

/**
 * CLI entry shared by dry-run and apply: a dry run never touches ports beyond
 * reading state, and a live run refuses to start while any quarantine entry
 * is unresolved. Exit statuses stay thin; operator-readable messages go to
 * the emit hook.
 */
export async function runCustomerWebMigrationCli(
  input: RunMigrationCliInput,
): Promise<MigrationOutcome> {
  const required = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`missing required option ${flag}`);
    }
    return value.trim();
  };
  const exportPath = required('--export', readOption(input.argv, '--export'));
  const organizationId = required('--org', readOption(input.argv, '--org'));
  const evidencePath = required(
    '--evidence',
    readOption(input.argv, '--evidence'),
  );
  const ownersRaw = readOption(input.argv, '--owners') ?? '';
  const ownerEmails = ownersRaw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (ownerEmails.length === 0) {
    throw new Error(
      'missing required option --owners (at least one owner email)',
    );
  }
  const dispositionsPath = readOption(input.argv, '--dispositions');
  const dryRun = input.argv.includes('--apply') === false;

  const exportText = await readFile(exportPath, 'utf8');
  const clerkExport = parseMigrationExportFile(exportText);
  const dispositions =
    dispositionsPath === undefined
      ? {}
      : parseDispositionsFile(await readFile(dispositionsPath, 'utf8'));

  const client = (input.createClient ?? createPostgresIdentityClient)(
    input.databaseUrl,
  );
  const base = createDatabaseMigrationPorts({ client, organizationId });
  const ports: MigrationPorts = {
    ...base,
    writeEvidence: async (text) => {
      if (input.evidenceOut !== undefined) {
        await input.evidenceOut(text, evidencePath);
        return;
      }
      await mkdir(dirname(resolve(evidencePath)), { recursive: true });
      await writeFile(resolve(evidencePath), `${text}\n`, 'utf8');
    },
    emit: input.emit ?? console.log,
  };

  let outcome: MigrationOutcome;
  try {
    outcome = await runCustomerWebMigrationCommand({
      clerkExport,
      organizationId,
      ownerEmails,
      dispositions,
      dryRun,
      evidencePath,
      ports,
    });
  } finally {
    await client.close();
  }
  return outcome;
}
