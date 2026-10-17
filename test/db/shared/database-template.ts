import { createHash } from 'node:crypto';

export const DATABASE_LANE_TEMPLATE_NAME = 'aihub_db_lane_template';

const TEMPLATE_DESCRIPTION_PREFIX = 'aihub:db-lane-template:v1';

export type MigrationFile = {
  name: string;
  sql: string;
};

export function migrationFingerprint(
  migrations: readonly MigrationFile[],
): string {
  const hash = createHash('sha256');
  for (const migration of [...migrations].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    hash.update(migration.name).update('\0').update(migration.sql).update('\0');
  }
  return hash.digest('hex');
}

export function databaseTemplateDescription(
  fingerprint: string,
  state: 'building' | 'ready',
): string {
  return `${TEMPLATE_DESCRIPTION_PREFIX}:${fingerprint}:${state}`;
}

export function databaseTemplateAction(
  description: string | null,
  fingerprint: string,
): 'reuse' | 'rebuild' | 'unowned' {
  const match = new RegExp(
    `^${TEMPLATE_DESCRIPTION_PREFIX}:([a-f0-9]{64}):(building|ready)$`,
  ).exec(description ?? '');
  if (match === null) return 'unowned';
  return match[1] === fingerprint && match[2] === 'ready' ? 'reuse' : 'rebuild';
}
