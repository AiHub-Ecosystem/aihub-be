import type { ExecutionContext } from '@nestjs/common';

import type { ApiKeyAuthenticatorPort } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import { SandboxDemoKeyValidationGuard } from './sandbox-demo-key-validation.guard';

const CONFIG = {
  NODE_ENV: 'test',
  AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
  AIHUB_PRODUCTION_HOST: 'api.aihub.test',
  AIHUB_STAGING_HOST: undefined,
  AIHUB_DEVELOPMENT_HOST: undefined,
  AIHUB_SANDBOX_HOST: 'sandbox.aihub.test',
} satisfies RequestEnvironmentConfig;

const AUTHENTICATED = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_01',
  environment: 'sandbox',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 3,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
  allowedEnvironments: ['sandbox'],
};

class RecordingAuthenticator implements ApiKeyAuthenticatorPort {
  readonly credentials: {
    value: string;
    clientIp: string;
    additionalAbuseScopes?: readonly string[];
  }[] = [];

  async authenticate(input: {
    value: string;
    environment: string;
    clientIp: string;
    additionalAbuseScopes?: readonly string[];
  }): Promise<typeof AUTHENTICATED> {
    this.credentials.push(input);
    return AUTHENTICATED;
  }
}

function request(headers: Record<string, string>) {
  return {
    headers: { host: 'sandbox.aihub.test', ...headers },
    ip: '172.16.7.9',
  };
}

function context(value: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => value }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function guard(
  authenticator: RecordingAuthenticator,
): SandboxDemoKeyValidationGuard {
  return new SandboxDemoKeyValidationGuard(authenticator, CONFIG);
}

describe('SandboxDemoKeyValidationGuard', () => {
  it('scopes abuse protection to the presented credential as well as the shared BFF egress address', async () => {
    const authenticator = new RecordingAuthenticator();

    await guard(authenticator).canActivate(
      context(
        request({
          'x-api-key': `aihub_sandbox_${'A'.repeat(43)}`,
        }),
      ),
    );
    await guard(authenticator).canActivate(
      context(
        request({
          'x-api-key': `aihub_sandbox_${'B'.repeat(43)}`,
        }),
      ),
    );

    // The address stays, so a grind from one egress is still bounded; the
    // credential is added, so one visitor's mistakes cannot lock out the rest.
    expect(authenticator.credentials[0]?.clientIp).toBe('172.16.7.9');
    expect(authenticator.credentials[0]?.additionalAbuseScopes).toEqual([
      expect.stringMatching(/^key:[0-9a-f]{64}$/),
    ]);
    expect(authenticator.credentials[0]?.additionalAbuseScopes).not.toEqual(
      authenticator.credentials[1]?.additionalAbuseScopes,
    );
  });

  it('clamps the validation rate limit without touching the key identity', async () => {
    const authenticator = new RecordingAuthenticator();
    const value = request({ 'x-api-key': `aihub_sandbox_${'A'.repeat(43)}` });

    await guard(authenticator).canActivate(context(value));

    expect((value as { aihubAuth?: unknown }).aihubAuth).toMatchObject({
      apiKeyId: 'ak_01',
      rateLimitRpm: 5,
    });
  });
});
