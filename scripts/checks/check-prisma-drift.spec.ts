import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { driftStatements } from './prisma-drift.cjs';

const HEADER =
  'generator client {\n  provider = "prisma-client"\n  output   = "./client"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n';

const ALIGNED = `${HEADER}model ApiKey {\n  id String @id\n}\n`;

const MISMATCHED = `${HEADER}model ApiKey {\n  id        String  @id\n  name      String\n  createdAt DateTime @default(now())\n}\n`;

/**
 * Asks Prisma to diff one schema against another. No database, no adapter, no
 * client generation: this is the comparison the drift check makes, minus the
 * part that needs PostgreSQL.
 */
/**
 * Runs Prisma's CLI entry directly rather than through `npx`: the fixture paths
 * live under the OS temporary directory, and a Windows shell would split them
 * at the space in a user profile name.
 */
const PRISMA_CLI = require.resolve('prisma/build/index.js');

function diff(fromSchemaPath: string, toSchemaPath: string): string {
  const result = spawnSync(
    process.execPath,
    [
      PRISMA_CLI,
      'migrate',
      'diff',
      '--from-schema',
      fromSchemaPath,
      '--to-schema',
      toSchemaPath,
      '--script',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`prisma migrate diff failed: ${result.stderr}`);
  }

  return result.stdout;
}

describe('prisma drift verdict', () => {
  it('reports no drift when the two sides agree', () => {
    const output = '-- This is an empty migration.\n';
    expect(driftStatements(output)).toEqual([]);
  });

  it('reports no drift when the CLI prints nothing', () => {
    expect(driftStatements('')).toEqual([]);
  });

  it('names the statements a real mismatch produces', () => {
    // Captured from `prisma migrate diff` against the control-plane schema
    // while a column existed in the database and not in schema.prisma.
    const output = [
      '-- AlterTable',
      'ALTER TABLE "api_keys" DROP COLUMN "key_hash",',
      'ADD COLUMN     "keyHash" BYTEA NOT NULL;',
      '',
    ].join('\n');

    expect(driftStatements(output)).toEqual([
      'ALTER TABLE "api_keys" DROP COLUMN "key_hash",',
      'ADD COLUMN     "keyHash" BYTEA NOT NULL;',
    ]);
  });
});

describe('prisma drift between a schema pair', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'aihub-prisma-drift-'));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('fails a mismatched pair', () => {
    const aligned = join(workspace, 'aligned.prisma');
    const mismatched = join(workspace, 'mismatched.prisma');
    writeFileSync(aligned, ALIGNED);
    writeFileSync(mismatched, MISMATCHED);

    const drifted = driftStatements(diff(aligned, mismatched));

    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted.join('\n')).toContain('"name"');
    expect(drifted.join('\n')).toContain('"createdAt"');
  });

  it('passes an aligned pair', () => {
    const aligned = join(workspace, 'same-a.prisma');
    const sameCopy = join(workspace, 'same-b.prisma');
    writeFileSync(aligned, ALIGNED);
    writeFileSync(sameCopy, ALIGNED);

    expect(driftStatements(diff(aligned, sameCopy))).toEqual([]);
  });
});
