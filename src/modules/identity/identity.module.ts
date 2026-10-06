import { Module } from '@nestjs/common';
import { DrizzleModule, getDrizzleToken } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

import {
  OPAQUE_TOKEN_BINDINGS,
  opaqueTokenIssuer,
} from '@/common/security/opaque-token-issuer';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import {
  EMAIL_DELIVERY_REQUEST_WRITER,
  EMAIL_PAYLOAD_CIPHER,
  type EmailDeliveryRequestWriterPort,
  type EmailPayloadCipherPort,
} from '@/modules/auth/application/email-delivery-request.port';
import { AuthModule } from '@/modules/auth/auth.module';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';

import { CreateOrganizationApiKey } from './api-keys/application/create-organization-api-key';
import { CREATE_ORGANIZATION_API_KEY } from './api-keys/application/create-organization-api-key.port';
import { ListOrganizationApiKeys } from './api-keys/application/list-organization-api-keys';
import { LIST_ORGANIZATION_API_KEYS } from './api-keys/application/list-organization-api-keys.port';
import {
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
} from './api-keys/application/organization-api-key.port';
import { RevokeOrganizationApiKey } from './api-keys/application/revoke-organization-api-key';
import { REVOKE_ORGANIZATION_API_KEY } from './api-keys/application/revoke-organization-api-key.port';
import { RotateOrganizationApiKey } from './api-keys/application/rotate-organization-api-key';
import { ROTATE_ORGANIZATION_API_KEY } from './api-keys/application/rotate-organization-api-key.port';
import { PostgresOrganizationApiKeyRepository } from './api-keys/infrastructure/postgres-organization-api-key.repository';
import { OrganizationApiKeyController } from './api-keys/presentation/organization-api-key.controller';
import { AcceptOrganizationInvitation } from './application/accept-organization-invitation';
import { ACCEPT_ORGANIZATION_INVITATION } from './application/accept-organization-invitation.port';
import { ApiKeyAuthenticator } from './application/api-key-authenticator';
import {
  API_KEY_AUTHENTICATOR,
  API_KEY_CACHE,
  API_KEY_REPOSITORY,
  AUTH_FAILURE_COUNTER,
  type ApiKeyCachePort,
  type ApiKeyRepositoryPort,
  type AuthFailureCounterPort,
} from './application/api-key-authenticator.port';
import {
  CreateOrganization,
  selfServeMonthlyRequestQuota,
  selfServeOrganizationTerms,
} from './application/create-organization';
import { CREATE_ORGANIZATION } from './application/create-organization.port';
import { InviteOrganizationMember } from './application/invite-organization-member';
import { INVITE_ORGANIZATION_MEMBER } from './application/invite-organization-member.port';
import { JWKS_CACHE, type JwksCachePort } from './application/jwks-cache.port';
import {
  JWKS_KEY_PROVIDER,
  type JwksKeyProviderPort,
} from './application/jwks-key-provider.port';
import { ListOpenOrganizationInvitations } from './application/list-open-organization-invitations';
import { LIST_OPEN_ORGANIZATION_INVITATIONS } from './application/list-open-organization-invitations.port';
import { ListOrganizationMemberships } from './application/list-organization-memberships';
import { ManageOrganizationMembership } from './application/manage-organization-membership';
import { MintSandboxAssertion } from './application/mint-sandbox-assertion';
import {
  ORGANIZATION_AUDIT_EVENT_READ,
  type OrganizationAuditEventReadPort,
} from './application/organization-audit-event-read.port';
import {
  ORGANIZATION_CREATION_RECORD,
  type OrganizationCreationRecordPort,
} from './application/organization-creation-record.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from './application/organization-identity-config-repository.port';
import {
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from './application/organization-invitation.port';
import {
  ORGANIZATION_INVITE_TOKEN,
  type OrganizationInviteTokenPort,
} from './application/organization-invite-token.port';
import {
  ORGANIZATION_MEMBERSHIP_LIST,
  type OrganizationMembershipListPort,
} from './application/organization-membership-list.port';
import {
  ORGANIZATION_MEMBERSHIP_MUTATION,
  type OrganizationMembershipMutationPort,
} from './application/organization-membership-mutation.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from './application/organization-membership.port';
import {
  ORGANIZATION_RENAME_RECORD,
  type OrganizationRenameRecordPort,
} from './application/organization-rename-record.port';
import { ReadOrganizationAuditEvents } from './application/read-organization-audit-events';
import { READ_ORGANIZATION_AUDIT_EVENTS } from './application/read-organization-audit-events.port';
import { ReadOrganizationIdentityConfig } from './application/read-organization-identity-config';
import { READ_ORGANIZATION_IDENTITY_CONFIG } from './application/read-organization-identity-config.port';
import { RenameOrganization } from './application/rename-organization';
import { RENAME_ORGANIZATION } from './application/rename-organization.port';
import { RevokeOrganizationInvitation } from './application/revoke-organization-invitation';
import { REVOKE_ORGANIZATION_INVITATION } from './application/revoke-organization-invitation.port';
import { SANDBOX_ASSERTION_MINTER } from './application/sandbox-assertion-minter.port';
import { SANDBOX_ASSERTION_POLICY } from './application/sandbox-assertion-policy.port';
import {
  SANDBOX_ASSERTION_SIGNER,
  type SandboxAssertionSignerPort,
} from './application/sandbox-assertion-signer.port';
import { SetOrganizationIdentityConfig } from './application/set-organization-identity-config';
import { SET_ORGANIZATION_IDENTITY_CONFIG } from './application/set-organization-identity-config.port';
import {
  USER_ASSERTION_CRYPTO,
  type UserAssertionCryptoPort,
} from './application/user-assertion-crypto.port';
import { UserAssertionVerifier } from './application/user-assertion-verifier';
import { UserIdentityResolver } from './application/user-identity-resolver';
import { USER_IDENTITY_RESOLVER } from './application/user-identity-resolver.port';
import { identityDrizzleSchema } from './infrastructure/drizzle-identity-schema';
import { EnvSandboxAssertionPolicy } from './infrastructure/env-sandbox-assertion-policy';
import { JoseSandboxAssertionSigner } from './infrastructure/jose-sandbox-assertion-signer';
import { JoseUserAssertionCrypto } from './infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from './infrastructure/jwks-key-provider';
import { PostgresApiKeyRepository } from './infrastructure/postgres-api-key.repository';
import {
  type IdentityDatabase,
  createPostgresIdentityClient,
  identityDrizzleConnectionOptions,
} from './infrastructure/postgres-identity.client';
import { PostgresOrganizationAuditReadRepository } from './infrastructure/postgres-organization-audit-read.repository';
import { PostgresOrganizationCreationRepository } from './infrastructure/postgres-organization-creation.repository';
import { PostgresOrganizationIdentityConfigRepository } from './infrastructure/postgres-organization-identity-config.repository';
import { PostgresOrganizationInvitationRepository } from './infrastructure/postgres-organization-invitation.repository';
import { PostgresOrganizationMembershipRepository } from './infrastructure/postgres-organization-membership.repository';
import { PostgresOrganizationRenameRepository } from './infrastructure/postgres-organization-rename.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from './infrastructure/redis-identity.store';
import { ApiKeyUserIdentityGuard } from './presentation/api-key-user-identity.guard';
import { ApiKeyGuard } from './presentation/api-key.guard';
import { OrganizationAuditEventController } from './presentation/organization-audit-event.controller';
import { OrganizationIdentityConfigController } from './presentation/organization-identity-config.controller';
import { OrganizationInvitationController } from './presentation/organization-invitation.controller';
import { OrganizationMembershipController } from './presentation/organization-membership.controller';
import { OrganizationController } from './presentation/organization.controller';
import { SandboxApiKeyGuard } from './presentation/sandbox-api-key.guard';
import { SandboxAssertionController } from './presentation/sandbox-assertion.controller';
import { UserIdentityGuard } from './presentation/user-identity.guard';

function controlPlaneDatabaseUrl(): string {
  return (
    process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL ?? ''
  );
}

// Each repository owns its client (they expose `close()` passthroughs), so
// this names the construction rather than sharing one pool across them.
function postgresIdentityClient(): ReturnType<
  typeof createPostgresIdentityClient
> {
  return createPostgresIdentityClient(controlPlaneDatabaseUrl());
}

function controlPlaneReadDatabaseUrl(): string {
  return (
    process.env.CONTROL_PLANE_READ_DATABASE_URL ??
    process.env.CONTROL_PLANE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    ''
  );
}

const IDENTITY_READ_DATABASE = 'identity-read';
const IDENTITY_WRITE_DATABASE = 'identity-write';

function drizzleDatabaseOptions(databaseUrl: string) {
  if (databaseUrl.trim().length === 0) {
    return { db: drizzle.mock({ schema: identityDrizzleSchema }) };
  }

  return {
    drizzle,
    connection: identityDrizzleConnectionOptions(databaseUrl),
    schema: identityDrizzleSchema,
  };
}

@Module({
  // `RateLimitGuard` on the sandbox route consumes the gateway's rate limiter.
  imports: [
    AuthModule,
    GatewayModule,
    IdempotencyModule,
    DrizzleModule.forRootAsync({
      name: IDENTITY_READ_DATABASE,
      useFactory: () => drizzleDatabaseOptions(controlPlaneReadDatabaseUrl()),
    }),
    DrizzleModule.forRootAsync({
      name: IDENTITY_WRITE_DATABASE,
      useFactory: () => drizzleDatabaseOptions(controlPlaneDatabaseUrl()),
    }),
  ],
  controllers: [
    SandboxAssertionController,
    OrganizationController,
    OrganizationMembershipController,
    OrganizationInvitationController,
    OrganizationApiKeyController,
    OrganizationAuditEventController,
    OrganizationIdentityConfigController,
  ],
  providers: [
    {
      provide: API_KEY_REPOSITORY,
      useFactory: (db: IdentityDatabase) =>
        new PostgresApiKeyRepository({ db }),
      inject: [getDrizzleToken(IDENTITY_READ_DATABASE)],
    },
    {
      provide: ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
      useFactory: (
        writeDb: IdentityDatabase,
        readDb: IdentityDatabase,
      ): OrganizationIdentityConfigRepositoryPort =>
        new PostgresOrganizationIdentityConfigRepository(
          { db: writeDb },
          { db: readDb },
        ),
      inject: [
        getDrizzleToken(IDENTITY_WRITE_DATABASE),
        getDrizzleToken(IDENTITY_READ_DATABASE),
      ],
    },
    {
      provide: ORGANIZATION_MEMBERSHIP,
      useFactory: (): OrganizationMembershipPort =>
        new PostgresOrganizationMembershipRepository(postgresIdentityClient()),
    },
    {
      provide: ORGANIZATION_MEMBERSHIP_LIST,
      useExisting: ORGANIZATION_MEMBERSHIP,
    },
    {
      provide: ListOrganizationMemberships,
      useFactory: (membership: OrganizationMembershipListPort) =>
        new ListOrganizationMemberships(membership),
      inject: [ORGANIZATION_MEMBERSHIP_LIST],
    },
    {
      provide: ORGANIZATION_MEMBERSHIP_MUTATION,
      useFactory: (
        membership: OrganizationMembershipPort,
      ): OrganizationMembershipMutationPort =>
        new ManageOrganizationMembership(membership),
      inject: [ORGANIZATION_MEMBERSHIP],
    },
    {
      provide: ORGANIZATION_CREATION_RECORD,
      useFactory: (): OrganizationCreationRecordPort =>
        new PostgresOrganizationCreationRepository(postgresIdentityClient()),
    },
    {
      provide: CREATE_ORGANIZATION,
      useFactory: (organizations: OrganizationCreationRecordPort) =>
        new CreateOrganization(
          organizations,
          selfServeOrganizationTerms(
            selfServeMonthlyRequestQuota(
              process.env.AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA,
            ),
          ),
        ),
      inject: [ORGANIZATION_CREATION_RECORD],
    },
    {
      provide: ORGANIZATION_RENAME_RECORD,
      useFactory: (): OrganizationRenameRecordPort =>
        new PostgresOrganizationRenameRepository(postgresIdentityClient()),
    },
    {
      provide: RENAME_ORGANIZATION,
      useFactory: (organizations: OrganizationRenameRecordPort) =>
        new RenameOrganization(organizations),
      inject: [ORGANIZATION_RENAME_RECORD],
    },
    {
      provide: ORGANIZATION_API_KEY,
      useFactory: (): OrganizationApiKeyPort =>
        new PostgresOrganizationApiKeyRepository(postgresIdentityClient()),
    },
    {
      provide: CREATE_ORGANIZATION_API_KEY,
      useFactory: (
        membership: OrganizationMembershipPort,
        apiKeys: OrganizationApiKeyPort,
      ) => new CreateOrganizationApiKey(membership, apiKeys),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_API_KEY],
    },
    {
      provide: ORGANIZATION_AUDIT_EVENT_READ,
      useFactory: (): OrganizationAuditEventReadPort =>
        new PostgresOrganizationAuditReadRepository(postgresIdentityClient()),
    },
    {
      provide: READ_ORGANIZATION_AUDIT_EVENTS,
      useFactory: (
        membership: OrganizationMembershipPort,
        auditEvents: OrganizationAuditEventReadPort,
      ) => new ReadOrganizationAuditEvents(membership, auditEvents),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_AUDIT_EVENT_READ],
    },
    {
      provide: READ_ORGANIZATION_IDENTITY_CONFIG,
      useFactory: (
        membership: OrganizationMembershipPort,
        configs: OrganizationIdentityConfigRepositoryPort,
      ) => new ReadOrganizationIdentityConfig(membership, configs),
      inject: [
        ORGANIZATION_MEMBERSHIP,
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
      ],
    },
    {
      provide: SET_ORGANIZATION_IDENTITY_CONFIG,
      useFactory: (
        membership: OrganizationMembershipPort,
        configs: OrganizationIdentityConfigRepositoryPort,
        keys: JwksKeyProviderPort,
        cache: JwksCachePort,
      ) => new SetOrganizationIdentityConfig(membership, configs, keys, cache),
      inject: [
        ORGANIZATION_MEMBERSHIP,
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
        JWKS_KEY_PROVIDER,
        JWKS_CACHE,
      ],
    },
    {
      provide: LIST_ORGANIZATION_API_KEYS,
      useFactory: (
        membership: OrganizationMembershipPort,
        apiKeys: OrganizationApiKeyPort,
      ) => new ListOrganizationApiKeys(membership, apiKeys),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_API_KEY],
    },
    {
      provide: ROTATE_ORGANIZATION_API_KEY,
      useFactory: (
        membership: OrganizationMembershipPort,
        apiKeys: OrganizationApiKeyPort,
        cache: ApiKeyCachePort,
      ) => new RotateOrganizationApiKey(membership, apiKeys, cache),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_API_KEY, API_KEY_CACHE],
    },
    {
      provide: REVOKE_ORGANIZATION_API_KEY,
      useFactory: (
        membership: OrganizationMembershipPort,
        apiKeys: OrganizationApiKeyPort,
        cache: ApiKeyCachePort,
      ) => new RevokeOrganizationApiKey(membership, apiKeys, cache),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_API_KEY, API_KEY_CACHE],
    },
    {
      provide: ORGANIZATION_INVITATION,
      useFactory: (
        payloadCipher: EmailPayloadCipherPort,
        emailRequests: EmailDeliveryRequestWriterPort,
      ): OrganizationInvitationPort =>
        new PostgresOrganizationInvitationRepository(
          postgresIdentityClient(),
          payloadCipher,
          emailRequests,
        ),
      inject: [EMAIL_PAYLOAD_CIPHER, EMAIL_DELIVERY_REQUEST_WRITER],
    },
    {
      provide: ORGANIZATION_INVITE_TOKEN,
      useFactory: (): OrganizationInviteTokenPort =>
        opaqueTokenIssuer(
          OPAQUE_TOKEN_BINDINGS.organizationInvite.prefix,
          OPAQUE_TOKEN_BINDINGS.organizationInvite.ttlMs,
        ),
    },
    {
      provide: INVITE_ORGANIZATION_MEMBER,
      useFactory: (
        membership: OrganizationMembershipPort,
        invitations: OrganizationInvitationPort,
        tokenIssuer: OrganizationInviteTokenPort,
        rateLimiter: AuthRateLimiterPort,
      ) =>
        new InviteOrganizationMember(
          membership,
          invitations,
          tokenIssuer,
          rateLimiter,
        ),
      inject: [
        ORGANIZATION_MEMBERSHIP,
        ORGANIZATION_INVITATION,
        ORGANIZATION_INVITE_TOKEN,
        AUTH_RATE_LIMITER,
      ],
    },
    {
      provide: ACCEPT_ORGANIZATION_INVITATION,
      useFactory: (
        invitations: OrganizationInvitationPort,
        tokenIssuer: OrganizationInviteTokenPort,
      ) => new AcceptOrganizationInvitation(invitations, tokenIssuer),
      inject: [ORGANIZATION_INVITATION, ORGANIZATION_INVITE_TOKEN],
    },
    {
      provide: LIST_OPEN_ORGANIZATION_INVITATIONS,
      useFactory: (
        membership: OrganizationMembershipPort,
        invitations: OrganizationInvitationPort,
      ) => new ListOpenOrganizationInvitations(membership, invitations),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_INVITATION],
    },
    {
      provide: REVOKE_ORGANIZATION_INVITATION,
      useFactory: (
        membership: OrganizationMembershipPort,
        invitations: OrganizationInvitationPort,
      ) => new RevokeOrganizationInvitation(membership, invitations),
      inject: [ORGANIZATION_MEMBERSHIP, ORGANIZATION_INVITATION],
    },
    {
      provide: API_KEY_CACHE,
      useFactory: () => new RedisIdentityStore(process.env.REDIS_URL ?? ''),
    },
    {
      provide: JWKS_CACHE,
      useExisting: API_KEY_CACHE,
    },
    {
      provide: AUTH_FAILURE_COUNTER,
      useFactory: () =>
        new RedisAuthFailureCounter(process.env.REDIS_URL ?? ''),
    },
    {
      provide: API_KEY_AUTHENTICATOR,
      useFactory: (
        repository: ApiKeyRepositoryPort,
        cache: ApiKeyCachePort,
        failureCounter: AuthFailureCounterPort,
      ) => new ApiKeyAuthenticator(repository, cache, failureCounter),
      inject: [API_KEY_REPOSITORY, API_KEY_CACHE, AUTH_FAILURE_COUNTER],
    },
    {
      provide: JWKS_KEY_PROVIDER,
      useFactory: (cache: JwksCachePort): JwksKeyProviderPort =>
        new JwksKeyProvider(cache),
      inject: [JWKS_CACHE],
    },
    {
      provide: USER_IDENTITY_RESOLVER,
      useFactory: (
        repository: OrganizationIdentityConfigRepositoryPort,
        keyProvider: JwksKeyProviderPort,
        crypto: UserAssertionCryptoPort,
      ) =>
        new UserIdentityResolver(
          repository,
          new UserAssertionVerifier(keyProvider, crypto),
        ),
      inject: [
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
        JWKS_KEY_PROVIDER,
        USER_ASSERTION_CRYPTO,
      ],
    },
    {
      provide: USER_ASSERTION_CRYPTO,
      useClass: JoseUserAssertionCrypto,
    },
    {
      provide: SANDBOX_ASSERTION_POLICY,
      useClass: EnvSandboxAssertionPolicy,
    },
    {
      // The signer resolves its key on first use, not here: this factory runs
      // while the module graph is assembled, and a deployment without a
      // sandbox must still assemble.
      provide: SANDBOX_ASSERTION_SIGNER,
      useClass: JoseSandboxAssertionSigner,
    },
    {
      provide: SANDBOX_ASSERTION_MINTER,
      useFactory: (
        repository: OrganizationIdentityConfigRepositoryPort,
        signer: SandboxAssertionSignerPort,
      ) => new MintSandboxAssertion(repository, signer),
      inject: [
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
        SANDBOX_ASSERTION_SIGNER,
      ],
    },
    ApiKeyGuard,
    ApiKeyUserIdentityGuard,
    SandboxApiKeyGuard,
    UserIdentityGuard,
  ],
  exports: [
    API_KEY_AUTHENTICATOR,
    ApiKeyGuard,
    ApiKeyUserIdentityGuard,
    UserIdentityGuard,
    ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
    ORGANIZATION_MEMBERSHIP,
    USER_IDENTITY_RESOLVER,
  ],
})
export class IdentityModule {}
