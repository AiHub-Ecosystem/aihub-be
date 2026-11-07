/**
 * Seeds the disposable DAST database with the one Organization, gateway API
 * key, and User Account the scan authenticates with (issue #319).
 *
 *   DATABASE_URL=postgres://... node --import tsx scripts/ci/dast-seed.ts \
 *     --out temp/dast
 *
 * The key, the password, and the bearer token they mint are created inside the
 * CI job and written to the job's temp directory; nothing is committed and no
 * production secret is read. The seeded bearer user belongs to no
 * Organization, so every Organization-scoped management route answers the safe
 * authorization denial — which is what keeps the scan's destructive requests
 * from mutating anything even when the context exclusion is bypassed.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma-client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { ulid } from 'ulid';

import { ARGON2ID_PARAMETERS } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { generateApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';

const DAST_EMAIL = 'dast-scanner@example.com';
const DAST_USERNAME = 'dast_scanner';
const DAST_ORG_NAME = 'DAST Target Organization';
const DAST_KEY_NAME = 'DAST scan key';
const DAST_PASSWORD_LENGTH = 24;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface DastCredentials {
  readonly apiKey: string;
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** The same base62 minting the application's key generator uses. */
function randomPassword(length: number): string {
  const bytes = randomBytes(length);
  let password = '';
  for (const byte of bytes) {
    password += BASE62[byte % BASE62.length];
  }
  return password;
}

function outDirectory(): string {
  const index = process.argv.indexOf('--out');
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  if (directory === undefined || directory.length === 0) {
    console.error(
      'usage: node --import tsx scripts/ci/dast-seed.ts --out <dir>',
    );
    process.exit(2);
  }
  return directory;
}

async function seed(): Promise<DastCredentials> {
  if (
    process.env.DATABASE_URL === undefined ||
    process.env.DATABASE_URL.length === 0
  ) {
    throw new Error('DATABASE_URL is required for the DAST seed');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: 'aihub-dast-seed',
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const now = new Date();
    const organizationId = `org_${ulid(now.getTime())}`;
    const userId = `usr_${ulid(now.getTime())}`;
    const authIdentityId = `auth_${ulid(now.getTime())}`;
    const key = generateApiKey(`ak_${ulid(now.getTime())}`, 'production');
    const password = randomPassword(DAST_PASSWORD_LENGTH);
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: ARGON2ID_PARAMETERS.memoryCost,
      timeCost: ARGON2ID_PARAMETERS.timeCost,
      parallelism: ARGON2ID_PARAMETERS.parallelism,
    });

    // Replace any rows a previous run of the same job left behind, so the
    // seed is idempotent within its disposable database.
    await prisma.$transaction([
      prisma.apiKey.deleteMany({ where: { id: key.id } }),
      prisma.authIdentity.deleteMany({ where: { id: authIdentityId } }),
      prisma.userAccount.deleteMany({ where: { id: userId } }),
      prisma.organization.deleteMany({ where: { id: organizationId } }),
      prisma.organization.create({
        data: {
          id: organizationId,
          name: DAST_ORG_NAME,
          entitlements: ['writing', 'speaking'],
        },
      }),
      prisma.apiKey.create({
        data: {
          id: key.id,
          organizationId,
          keyHash: Buffer.from(key.hash, 'hex'),
          keyPrefix: key.prefix,
          name: DAST_KEY_NAME,
          scopes: ['writing.grade', 'speaking.grade'],
          allowedEnvironments: ['production'],
        },
      }),
      prisma.userAccount.create({
        data: {
          id: userId,
          username: DAST_USERNAME,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      }),
      prisma.authIdentity.create({
        data: {
          id: authIdentityId,
          userAccountId: userId,
          provider: 'password',
          canonicalEmail: DAST_EMAIL,
          passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);

    return {
      apiKey: key.raw,
      apiKeyId: key.id,
      organizationId,
      username: DAST_USERNAME,
      email: DAST_EMAIL,
      password,
    };
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const credentials = await seed();
  const directory = outDirectory();
  mkdirSync(directory, { recursive: true });
  const credentialsPath = join(directory, 'dast-credentials.json');
  writeFileSync(credentialsPath, `${JSON.stringify(credentials)}\n`);
  console.log(`dast-seed: wrote ${credentialsPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`dast-seed: ${message}`);
  process.exit(1);
});
