import { Test, type TestingModule } from '@nestjs/testing';
import { decodeJwt } from 'jose';

import { appConfig } from '@/config/runtime-configuration';
import { AuthRuntimeModule } from '@/modules/auth/auth-runtime.module';
import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { BloomFilterUserAccessTokenRevocationAdapter } from '@/modules/auth/user-access-tokens/infrastructure/bloom-filter/bloom-filter-user-access-token-revocation.adapter';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '@/modules/secrets/application/runtime-secret-provider.port';

describe('Auth runtime User Access JWT scope', () => {
  let productionModuleRef: TestingModule | undefined;
  let sandboxModuleRef: TestingModule | undefined;
  const revocations: UserAccessTokenRevocationRecordPort = {
    async revoke() {},
    async isRevoked() {
      return false;
    },
    async listActiveRevocations() {
      return [];
    },
  };

  beforeAll(async () => {
    const configuration = appConfig();
    productionModuleRef = await Test.createTestingModule({
      imports: [AuthRuntimeModule],
    })
      .overrideProvider(appConfig.KEY)
      .useValue({
        ...configuration,
        AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
      })
      .overrideProvider(BloomFilterUserAccessTokenRevocationAdapter)
      .useValue(revocations)
      .compile();
    const runtimeSecretProvider =
      productionModuleRef.get<RuntimeSecretProvider>(RUNTIME_SECRET_PROVIDER);
    sandboxModuleRef = await Test.createTestingModule({
      imports: [AuthRuntimeModule],
    })
      .overrideProvider(appConfig.KEY)
      .useValue({
        ...configuration,
        AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
      })
      .overrideProvider(RUNTIME_SECRET_PROVIDER)
      .useValue(runtimeSecretProvider)
      .overrideProvider(BloomFilterUserAccessTokenRevocationAdapter)
      .useValue(revocations)
      .compile();
  });

  afterAll(async () => {
    await sandboxModuleRef?.close();
    await productionModuleRef?.close();
  });

  /** Pins the audience claims while both scopes share the same signing key. */
  async function assertRuntimeScopeTokenBoundary(): Promise<void> {
    const productionIssuer =
      productionModuleRef?.get<UserAccessTokenIssuerPort>(
        USER_ACCESS_TOKEN_ISSUER,
      );
    const productionVerifier =
      productionModuleRef?.get<UserAccessTokenVerifierPort>(
        USER_ACCESS_TOKEN_VERIFIER,
      );
    const sandboxIssuer = sandboxModuleRef?.get<UserAccessTokenIssuerPort>(
      USER_ACCESS_TOKEN_ISSUER,
    );
    const sandboxVerifier = sandboxModuleRef?.get<UserAccessTokenVerifierPort>(
      USER_ACCESS_TOKEN_VERIFIER,
    );

    if (
      productionIssuer === undefined ||
      productionVerifier === undefined ||
      sandboxIssuer === undefined ||
      sandboxVerifier === undefined
    ) {
      throw new Error('Auth runtime token providers were not initialized');
    }
    const [productionToken, sandboxToken] = await Promise.all([
      productionIssuer.issue('usr_01J00000000000000000000000'),
      sandboxIssuer.issue('usr_01J00000000000000000000000'),
    ]);

    expect(decodeJwt(productionToken.token).aud).toBe(
      'aihub-user-api:production',
    );
    expect(decodeJwt(sandboxToken.token).aud).toBe('aihub-user-api:sandbox');

    await expect(
      productionVerifier.verify(productionToken.token),
    ).resolves.toMatchObject({ userId: 'usr_01J00000000000000000000000' });
    await expect(
      sandboxVerifier.verify(sandboxToken.token),
    ).resolves.toMatchObject({ userId: 'usr_01J00000000000000000000000' });
    await expect(
      sandboxVerifier.verify(productionToken.token),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
    await expect(
      productionVerifier.verify(sandboxToken.token),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
  }

  it(
    'accepts same-scope tokens and rejects tokens from the other scope',
    assertRuntimeScopeTokenBoundary,
  );
});
