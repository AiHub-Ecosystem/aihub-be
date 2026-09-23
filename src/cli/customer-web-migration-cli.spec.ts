import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDispositionsFile,
  parseMigrationExportFile,
  runCustomerWebMigrationCli,
} from './customer-web-migration-cli';

const EXPORT = JSON.stringify({
  users: [
    { clerkUserId: 'clerk_1', email: 'boss@example.com', membership: 'active' },
    {
      clerkUserId: 'clerk_2',
      email: 'off@example.com',
      membership: 'disabled',
    },
  ],
  invitations: [{ email: 'new@example.com', role: 'member' }],
});

function fakeClient() {
  const noopTransaction = async <T>(callback: (client: never) => Promise<T>) =>
    callback(undefined as never);
  return {
    query: async () => [],
    transaction: noopTransaction,
    close: async () => undefined,
  };
}

describe('runCustomerWebMigrationCli', () => {
  it('dry-runs from files and reports the evidence digest without applying', async () => {
    const dir = await mkdtemp();
    const exportPath = join(dir, 'export.json');
    await writeFile(exportPath, EXPORT, 'utf8');
    const lines: string[] = [];
    const evidence: string[] = [];

    const outcome = await runCustomerWebMigrationCli({
      argv: [
        '--export',
        exportPath,
        '--org',
        'org_sandbox',
        '--owners',
        'boss@example.com',
        '--evidence',
        join(dir, 'evidence.json'),
      ],
      databaseUrl: 'postgres://unused',
      createClient: () => fakeClient(),
      evidenceOut: async (text) => {
        evidence.push(text);
      },
      emit: (line) => lines.push(line),
    });

    expect(outcome).toBe('dry_run');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain('"clerk_1"');
    expect(lines.join('\n')).toContain('readyToFlip=true');
    expect(lines.join('\n')).toContain('digest=');
    expect(lines.join('\n')).not.toContain('off@example.com');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails closed on missing options before touching any port', async () => {
    await expect(
      runCustomerWebMigrationCli({
        argv: ['--export', 'x.json'],
        databaseUrl: 'postgres://unused',
        createClient: () => fakeClient(),
        emit: () => undefined,
      }),
    ).rejects.toThrow('missing required option --org');
  });

  it('refuses to apply while quarantine remains, after writing evidence', async () => {
    const dir = await mkdtemp();
    const exportPath = join(dir, 'export.json');
    await writeFile(
      exportPath,
      JSON.stringify({
        users: [{ clerkUserId: 'clerk_9', email: null, membership: 'active' }],
        invitations: [],
      }),
      'utf8',
    );
    const evidence: string[] = [];

    const outcome = await runCustomerWebMigrationCli({
      argv: [
        '--export',
        exportPath,
        '--org',
        'org_sandbox',
        '--owners',
        'boss@example.com',
        '--evidence',
        join(dir, 'evidence.json'),
        '--apply',
      ],
      databaseUrl: 'postgres://unused',
      createClient: () => fakeClient(),
      evidenceOut: async (text) => {
        evidence.push(text);
      },
      emit: () => undefined,
    });

    expect(outcome).toBe('blocked_quarantine');
    expect(evidence).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('parseMigrationExportFile', () => {
  it('rejects rows that cannot be matched safely', () => {
    expect(() =>
      parseMigrationExportFile(
        JSON.stringify({
          users: [{ email: 'a@example.com' }],
          invitations: [],
        }),
      ),
    ).toThrow('clerkUserId');
    expect(() =>
      parseMigrationExportFile(JSON.stringify({ users: [], invitations: [] })),
    ).not.toThrow();
  });
});

describe('parseDispositionsFile', () => {
  it('accepts link/create/skip and rejects anything else', () => {
    expect(
      parseDispositionsFile(
        JSON.stringify({
          clerk_1: { kind: 'skip' },
          clerk_2: { kind: 'create' },
          clerk_3: { kind: 'link', accountId: 'usr_X' },
        }),
      ),
    ).toEqual({
      clerk_1: { kind: 'skip' },
      clerk_2: { kind: 'create' },
      clerk_3: { kind: 'link', accountId: 'usr_X' },
    });
    expect(() =>
      parseDispositionsFile(JSON.stringify({ clerk_1: { kind: 'merge' } })),
    ).toThrow('clerk_1');
  });
});

async function mkdtemp(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'cw-migration-'));
}
