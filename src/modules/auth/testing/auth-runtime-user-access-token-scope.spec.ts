import { Test, type TestingModule } from '@nestjs/testing';
import { decodeJwt } from 'jose';

import { appConfig } from '@/config/runtime-configuration';
import { AuthRuntimeModule } from '@/modules/auth/auth-runtime.module';
import {
  USER_ACCESS_TOKEN_ISSUER,
  type UserAccessTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

describe('Auth runtime User Access JWT scope', () => {
  let moduleRef: TestingModule | undefined;

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('uses the sandbox database scope as the token audience', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AuthRuntimeModule],
    })
      .overrideProvider(appConfig.KEY)
      .useValue({
        ...appConfig(),
        AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
      })
      .compile();
    const issuer = moduleRef.get<UserAccessTokenIssuerPort>(
      USER_ACCESS_TOKEN_ISSUER,
    );

    const issued = await issuer.issue('usr_01J00000000000000000000000');

    expect(decodeJwt(issued.token).aud).toBe('aihub-user-api:sandbox');
  });
});
