#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const schemaPath = join(root, 'prisma', 'schema.prisma');
const srcModules = join(root, 'src', 'modules');

const schema = readFileSync(schemaPath, 'utf8');
const tables = [];
let lastOwner = null;
let current = null;
for (const line of schema.split(/\r?\n/)) {
  const om = /^\s*\/\/\/\s*@owner\s+(\w+)/.exec(line);
  if (om) {
    lastOwner = om[1];
    continue;
  }
  const mm = /^\s*model\s+(\w+)\s*\{/.exec(line);
  if (mm) {
    current = { model: mm[1], owner: lastOwner, table: null };
    continue;
  }
  if (current) {
    const tm = /@@map\("([^"]+)"\)/.exec(line);
    if (tm) current.table = tm[1];
    if (/^\s*\}/.test(line)) {
      if (!current.table) {
        current.table = current.model.replace(
          /([A-Z])/g,
          (c, i) => (i ? '_' : '') + c.toLowerCase(),
        );
      }
      tables.push(current);
      current = null;
      lastOwner = null;
    }
  }
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts'))
      out.push(p);
  }
  return out;
}

const allowlist = new Map([
  [
    'src/modules/identity/organizations/infrastructure/postgres-organization-creation.repository.ts::user_accounts',
    'locks auth-owned account row during org creation (lock order recorded)',
  ],
  [
    'src/modules/identity/shared/infrastructure/active-account.ts::user_accounts',
    'reads active status for identity flows',
  ],
  [
    'src/modules/identity/membership/infrastructure/postgres-organization-membership.repository.ts::user_accounts',
    'reads account status for membership',
  ],
  [
    'src/modules/identity/audit/infrastructure/postgres-organization-audit-read.repository.ts::user_accounts',
    'display actor status',
  ],
  [
    'src/modules/identity/organizations/infrastructure/postgres-organization-first-owner.repository.ts::user_accounts',
    'Prisma read of account for first owner',
  ],
  [
    'src/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository.ts::user_accounts',
    'account status check',
  ],
  [
    'src/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository.ts::auth_identities',
    'account identity check',
  ],
  [
    'src/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices.ts::user_accounts',
    'near-expiry notice recipients must hold an active account (ADR-0120)',
  ],
  [
    'src/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices.ts::auth_identities',
    'near-expiry notice reads the recipient email at dispatch (ADR-0120)',
  ],
  [
    'src/modules/auth/local-credentials/infrastructure/postgres-email-credential.repository.ts::organization_invitations',
    'lookup invitation for email credential',
  ],
  [
    'src/modules/metering/infrastructure/postgres-billing-statement.repository.ts::api_keys',
    'display key metadata on billing statement',
  ],
  [
    'src/modules/metering/infrastructure/postgres-quota-reconciliation.repository.ts::organizations',
    'quota reconciliation by org',
  ],
]);

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let failed = false;
for (const file of collectFiles(srcModules)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const module = rel.split('/')[2];
  const source = readFileSync(file, 'utf8');
  for (const t of tables) {
    if (t.owner === module) continue;
    if (t.owner === null) continue;
    // Detect actual table reference: SQL keyword preceding table name, or Prisma accessor.
    const sqlRe = new RegExp(
      `\\b(?:FROM|INTO|JOIN|UPDATE|DELETE\\s+FROM|TABLE)\\s+[\`"']?${esc(t.table)}[\`"']?\\b`,
      'i',
    );
    const prismaRe = new RegExp(`\\.\\s*${esc(t.model)}\\b`);
    if (!sqlRe.test(source) && !prismaRe.test(source)) continue;
    const key = `${rel}::${t.table}`;
    if (allowlist.has(key)) continue;
    console.error(
      `${rel}: references table \`${t.table}\` owned by module \`${t.owner}\` without an allowlist entry.`,
    );
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log('Data ownership check passed.');
