import { Module } from '@nestjs/common';

import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '../auth/application/email-sender.port';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';

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
import { InviteOrganizationMember } from './application/invite-organization-member';
import { INVITE_ORGANIZATION_MEMBER } from './application/invite-organization-member.port';
import { JWKS_CACHE, type JwksCachePort } from './application/jwks-cache.port';
import {
  JWKS_KEY_PROVIDER,
  type JwksKeyProviderPort,
} from './application/jwks-key-provider.port';
import { ManageOrganizationMembership } from './application/manage-organization-membership';
import { MintSandboxAssertion } from './application/mint-sandbox-assertion';
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
  ORGANIZATION_MEMBERSHIP_MUTATION,
  type OrganizationMembershipMutationPort,
} from './application/organization-membership-mutation.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from './application/organization-membership.port';
import { SANDBOX_ASSERTION_MINTER } from './application/sandbox-assertion-minter.port';
import { SANDBOX_ASSERTION_POLICY } from './application/sandbox-assertion-policy.port';
import {
  SANDBOX_ASSERTION_SIGNER,
  type SandboxAssertionSignerPort,
} from './application/sandbox-assertion-signer.port';
import {
  USER_ASSERTION_CRYPTO,
  type UserAssertionCryptoPort,
} from './application/user-assertion-crypto.port';
import { UserAssertionVerifier } from './application/user-assertion-verifier';
import { USER_ASSERTION_VERIFIER } from './application/user-assertion-verifier.port';
import { CryptoOrganizationInviteToken } from './infrastructure/crypto-organization-invite-token';
import { EnvSandboxAssertionPolicy } from './infrastructure/env-sandbox-assertion-policy';
import { JoseSandboxAssertionSigner } from './infrastructure/jose-sandbox-assertion-signer';
import { JoseUserAssertionCrypto } from './infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from './infrastructure/jwks-key-provider';
import { PostgresApiKeyRepository } from './infrastructure/postgres-api-key.repository';
import { createPostgresIdentityClient } from './infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from './infrastructure/postgres-organization-identity-config.repository';
import { PostgresOrganizationInvitationRepository } from './infrastructure/postgres-organization-invitation.repository';
import { PostgresOrganizationMembershipRepository } from './infrastructure/postgres-organization-membership.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from './infrastructure/redis-identity.store';
import { ApiKeyGuard } from './presentation/api-key.guard';
import { OrganizationInvitationController } from './presentation/organization-invitation.controller';
import { OrganizationMembershipController } from './presentation/organization-membership.controller';
import { SandboxApiKeyGuard } from './presentation/sandbox-api-key.guard';
import { SandboxAssertionController } from './presentation/sandbox-assertion.controller';
import { UserAssertionGuard } from './presentation/user-assertion.guard';

@Module({
  // `RateLimitGuard` on the sandbox route consumes the gateway's rate limiter.
  imports: [AuthModule, GatewayModule],
  controllers: [
    SandboxAssertionController,
    OrganizationMembershipController,
    OrganizationInvitationController,
  ],
  providers: [
    {
      provide: API_KEY_REPOSITORY,
      useFactory: () =>
        new PostgresApiKeyRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
      useFactory: (): OrganizationIdentityConfigRepositoryPort =>
        new PostgresOrganizationIdentityConfigRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: ORGANIZATION_MEMBERSHIP,
      useFactory: (): OrganizationMembershipPort =>
        new PostgresOrganizationMembershipRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
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
      provide: ORGANIZATION_INVITATION,
      useFactory: (): OrganizationInvitationPort =>
        new PostgresOrganizationInvitationRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: ORGANIZATION_INVITE_TOKEN,
      useClass: CryptoOrganizationInviteToken,
    },
    {
      provide: INVITE_ORGANIZATION_MEMBER,
      useFactory: (
        membership: OrganizationMembershipPort,
        invitations: OrganizationInvitationPort,
        tokenIssuer: OrganizationInviteTokenPort,
        emailSender: EmailSenderPort,
      ) =>
        new InviteOrganizationMember(
          membership,
          invitations,
          tokenIssuer,
          emailSender,
        ),
      inject: [
        ORGANIZATION_MEMBERSHIP,
        ORGANIZATION_INVITATION,
        ORGANIZATION_INVITE_TOKEN,
        EMAIL_SENDER,
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
      provide: USER_ASSERTION_VERIFIER,
      useFactory: (
        repository: OrganizationIdentityConfigRepositoryPort,
        keyProvider: JwksKeyProviderPort,
        crypto: UserAssertionCryptoPort,
      ) => new UserAssertionVerifier(repository, keyProvider, crypto),
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
    SandboxApiKeyGuard,
    UserAssertionGuard,
  ],
  exports: [
    API_KEY_AUTHENTICATOR,
    ApiKeyGuard,
    UserAssertionGuard,
    ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
    ORGANIZATION_MEMBERSHIP,
    USER_ASSERTION_VERIFIER,
  ],
})
export class IdentityModule {}
