import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Pool } from 'pg';

import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import {
  NO_USER_ACCESS_TOKEN_REVOCATIONS,
  verifiedUserAccessToken,
} from '@/modules/auth/testing/user-access-token-verifier.stub';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import { USER_ACCESS_TOKEN_REVOCATION_RECORD } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

export const REQUEST_ID = 'req_01J00000000000000000000000';

export interface IdentityAppOptions {
  /** A module builder with the suite's own repository overrides already applied. */
  readonly builder: TestingModuleBuilder;
  readonly pool: Pool;
  readonly jti?: string;
}

/** Applies the shared Bearer-boundary overrides, then boots the app. */
export async function buildIdentityApp({
  builder,
  pool,
  jti = 'jti_01',
}: IdentityAppOptions): Promise<NestFastifyApplication> {
  const verifier: UserAccessTokenVerifierPort = {
    verify: async (token) =>
      verifiedUserAccessToken(token.split('.')[0] ?? '', jti),
  };
  const userAccounts = userAccountStatus(async (userId) => {
    const result = await pool.query<{ status: 'active' | 'disabled' }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    return result.rows[0]?.status;
  });
  const moduleRef = await builder
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(userAccounts)
    .overrideProvider(USER_ACCESS_TOKEN_REVOCATION_RECORD)
    .useValue(NO_USER_ACCESS_TOKEN_REVOCATIONS)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => REQUEST_ID }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
