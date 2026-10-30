import type { FastifyReply, FastifyRequest } from 'fastify';

// Registers the 'uri' format validator that parseRequestBody relies on.
import '@/contracts/writing/task1';

import type { StoredOrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { ReadOrganizationIdentityConfigResult } from '@/modules/identity/organization-identity-configuration/application/read-organization-identity-config';
import type { ReadOrganizationIdentityConfigPort } from '@/modules/identity/organization-identity-configuration/application/read-organization-identity-config.port';
import type { SetOrganizationIdentityConfigPort } from '@/modules/identity/organization-identity-configuration/application/set-organization-identity-config.port';
import { OrganizationIdentityConfigController } from './organization-identity-config.controller';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';

function request(): FastifyRequest {
  return {
    id: REQUEST_ID,
    headers: {},
    aihubUser: { userId: USER_ID },
  } as unknown as FastifyRequest;
}

function reply(): FastifyReply {
  return { header: jest.fn() } as unknown as FastifyReply;
}

function storedConfig(
  overrides: Partial<StoredOrganizationIdentityConfig> = {},
): StoredOrganizationIdentityConfig {
  return {
    organizationId: ORGANIZATION_ID,
    issuer: 'https://acme.edu',
    jwksUrl: 'https://acme.edu/.well-known/jwks.json',
    publicKeysJwks: {
      keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'rsa-1', alg: 'RS256' }],
    },
    allowedAlgorithms: ['RS256', 'ES256'],
    maxAssertionTtlSeconds: 300,
    status: 'active',
    updatedAt: new Date('2026-09-22T12:34:56.000Z'),
    revision: '3',
    ...overrides,
  };
}

describe('OrganizationIdentityConfigController (unit)', () => {
  function subject(
    options: {
      readResult?: ReadOrganizationIdentityConfigResult;
      setResult?: StoredOrganizationIdentityConfig;
    } = {},
  ) {
    const readPort: jest.Mocked<ReadOrganizationIdentityConfigPort> = {
      read: jest.fn(
        async (_input) =>
          (options.readResult ?? {
            configured: false,
          }) as ReadOrganizationIdentityConfigResult,
      ),
    };
    const setPort: jest.Mocked<SetOrganizationIdentityConfigPort> = {
      set: jest.fn(async (_input) => options.setResult ?? storedConfig()),
    };
    return {
      controller: new OrganizationIdentityConfigController(readPort, setPort),
      readPort,
      setPort,
    };
  }

  it('returns configured:false when the Organization has no configuration', async () => {
    const { controller } = subject({ readResult: { configured: false } });

    const response = await controller.read(request(), ORGANIZATION_ID, reply());

    expect(response).toEqual({
      data: { configured: false },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns the configured payload when a configuration exists', async () => {
    const config = storedConfig();
    const { controller } = subject({
      readResult: { configured: true, config },
    });

    const response = await controller.read(request(), ORGANIZATION_ID, reply());

    expect(response.data).toMatchObject({
      configured: true,
      issuer: config.issuer,
    });
  });

  it('refuses an inline JWKS payload that is not a valid key set', async () => {
    const { controller, setPort } = subject();

    await expect(
      controller.set(
        request(),
        ORGANIZATION_ID,
        {
          issuer: 'https://acme.edu',
          jwks_url: null,
          public_keys_jwks: 42,
        },
        reply(),
      ),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_INVALID',
      retryable: false,
    });
    expect(setPort.set.mock.calls).toHaveLength(0);
  });

  it('coerces an absent public key set to null when a URL is given', async () => {
    const { controller, setPort } = subject();

    await controller.set(
      request(),
      ORGANIZATION_ID,
      {
        issuer: 'https://acme.edu',
        jwks_url: 'https://acme.edu/keys',
        public_keys_jwks: null,
      },
      reply(),
    );

    expect(setPort.set.mock.calls[0]?.[0]).toMatchObject({
      jwksUrl: 'https://acme.edu/keys',
      publicKeysJwks: null,
    });
  });

  it('coerces an absent JWKS URL to null when an inline key set is given', async () => {
    const { controller, setPort } = subject();
    const validJwks = {
      keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'rsa-1', alg: 'RS256' }],
    };

    await controller.set(
      request(),
      ORGANIZATION_ID,
      {
        issuer: 'https://acme.edu',
        public_keys_jwks: validJwks,
      },
      reply(),
    );

    expect(setPort.set.mock.calls[0]?.[0]).toMatchObject({
      jwksUrl: null,
      publicKeysJwks: validJwks,
    });
  });

  it('forwards algorithm and ttl overrides when supplied', async () => {
    const { controller, setPort } = subject();

    await controller.set(
      request(),
      ORGANIZATION_ID,
      {
        issuer: 'https://acme.edu',
        jwks_url: 'https://acme.edu/keys',
        public_keys_jwks: null,
        allowed_algorithms: ['RS256'],
        max_assertion_ttl_seconds: 120,
      },
      reply(),
    );

    const call = setPort.set.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      allowedAlgorithms: ['RS256'],
      maxAssertionTtlSeconds: 120,
    });
  });

  it('omits algorithm and ttl when they are absent', async () => {
    const { controller, setPort } = subject();

    await controller.set(
      request(),
      ORGANIZATION_ID,
      {
        issuer: 'https://acme.edu',
        jwks_url: 'https://acme.edu/keys',
        public_keys_jwks: null,
      },
      reply(),
    );

    const call = setPort.set.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('allowedAlgorithms');
    expect(call).not.toHaveProperty('maxAssertionTtlSeconds');
  });
});
