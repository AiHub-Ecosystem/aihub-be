import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The Drizzle definitions for the three tables the Identity persistence slice
 * reads and writes. They mirror `database/migrations/` and nothing else:
 * `organization_members` and `organization_audit_events` are reached through
 * Drizzle's SQL API instead, so no definition is added for them here.
 *
 * These describe the shape this slice already depends on. They are not the
 * schema's source of truth: migrations remain it, and #40 owns the tooling that
 * reconciles the two.
 */

/**
 * `node-postgres` hands `bytea` back as the same `Buffer` that goes in, so the
 * custom type carries values across without a conversion in either direction.
 */
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const organizations = pgTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    entitlements: text('entitlements').array().notNull().default(sql`'{}'`),
    rateLimitRpm: integer('rate_limit_rpm').notNull().default(600),
    maxConcurrent: integer('max_concurrent').notNull().default(20),
    monthlyRequestQuota: integer('monthly_request_quota'),
    hardStopOnQuota: boolean('hard_stop_on_quota').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByUserAccountId: text('created_by_user_account_id'),
  },
  (table) => [
    check(
      'organizations_status_check',
      sql`${table.status} in ('active', 'suspended')`,
    ),
    check('organizations_rate_limit_rpm_check', sql`${table.rateLimitRpm} > 0`),
    check(
      'organizations_max_concurrent_check',
      sql`${table.maxConcurrent} > 0`,
    ),
    check(
      'organizations_monthly_request_quota_check',
      sql`${table.monthlyRequestQuota} is null or ${table.monthlyRequestQuota} >= 0`,
    ),
    index('organizations_created_by_idx')
      .on(table.createdByUserAccountId)
      .where(sql`${table.createdByUserAccountId} is not null`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    keyHash: bytea('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    allowedEnvironments: text('allowed_environments')
      .array()
      .notNull()
      .default(sql`'{production}'`),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('api_keys_key_hash_check', sql`octet_length(${table.keyHash}) = 32`),
    check(
      'api_keys_status_check',
      sql`${table.status} in ('active', 'revoked')`,
    ),
    uniqueIndex('api_keys_hash_uq').on(table.keyHash),
    index('api_keys_org_idx').on(table.organizationId),
  ],
);

export const organizationIdentityConfigs = pgTable(
  'organization_identity_configs',
  {
    organizationId: text('organization_id')
      .primaryKey()
      .references(() => organizations.id),
    issuer: text('issuer').notNull(),
    jwksUrl: text('jwks_url'),
    publicKeysJwks: jsonb('public_keys_jwks'),
    allowedAlgorithms: text('allowed_algorithms')
      .array()
      .notNull()
      .default(sql`array['RS256', 'ES256']`),
    maxAssertionTtlSeconds: integer('max_assertion_ttl_seconds')
      .notNull()
      .default(300),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Kept as a database `bigint` and converted at this boundary, so a version
     * that outgrows the safe integer range still reaches the application port
     * as the exact digits PostgreSQL holds.
     */
    jwksCacheVersion: bigint('jwks_cache_version', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
  },
  (table) => [
    check(
      'organization_identity_configs_issuer_check',
      sql`length(${table.issuer}) between 1 and 2048 and ${table.issuer} = btrim(${table.issuer})`,
    ),
    check(
      'organization_identity_configs_jwks_url_check',
      sql`${table.jwksUrl} is null or (${table.jwksUrl} = btrim(${table.jwksUrl}) and left(lower(${table.jwksUrl}), 8) = 'https://')`,
    ),
    check(
      'organization_identity_configs_max_assertion_ttl_seconds_check',
      sql`${table.maxAssertionTtlSeconds} > 0 and ${table.maxAssertionTtlSeconds} <= 3600`,
    ),
    check(
      'organization_identity_configs_status_check',
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      'organization_identity_configs_key_source_check',
      sql`${table.jwksUrl} is not null or ${table.publicKeysJwks} is not null`,
    ),
    check(
      'organization_identity_configs_public_keys_jwks_check',
      sql`${table.publicKeysJwks} is null or is_public_identity_jwks(${table.publicKeysJwks})`,
    ),
    check(
      'organization_identity_configs_allowed_algorithms_check',
      sql`cardinality(${table.allowedAlgorithms}) > 0 and ${table.allowedAlgorithms} <@ array['RS256', 'ES256']`,
    ),
    check(
      'organization_identity_configs_jwks_cache_version_check',
      sql`${table.jwksCacheVersion} > 0`,
    ),
    uniqueIndex('oic_issuer_uq').on(table.issuer),
  ],
);
