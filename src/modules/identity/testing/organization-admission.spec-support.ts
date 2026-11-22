import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';

import { registerSecurityHeaders } from '@/common/http/security-headers.hook';
import {
  USER_ACCOUNT_REPOSITORY,
  type UserAccountRepositoryPort,
} from '@/modules/auth/accounts/application/user-account.port';
import {
  USER_ACCESS_TOKEN_REVOCATION_RECORD,
  type UserAccessTokenRevocationRecordPort,
} from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
  type VerifiedUserAccessToken,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import type { ApiKeyCachePort } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { OrganizationApiKeyPort } from '@/modules/identity/api-keys/application/organization-api-key.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';

export const DEFAULT_USER_ID = 'usr_01J00000000000000000000000';
export const DEFAULT_REQUEST_ID = 'req_01J00000000000000000000000';
export const DEFAULT_VALID_TOKEN = 'valid.token.value';
export const DEFAULT_REISSUED_TOKEN = 'reissued.token.value';

export type ReadAdmissionDenialCase = [label: string, arrange: () => void];

export type MutationAdmissionDenialCase = [
  label: string,
  arrange: () => void,
  storeReached: boolean,
];

export interface AuthorizationDenialExpectation {
  message: string;
  requestId?: string;
}

const NO_USER_ACCESS_TOKEN_REVOCATIONS: UserAccessTokenRevocationRecordPort = {
  revoke: async () => undefined,
  isRevoked: async () => false,
  listActiveRevocations: async () => [],
};

function stubVerifiedUserAccessToken(
  userId: string,
  jti: string,
): VerifiedUserAccessToken {
  return {
    userId,
    issuer: 'https://api.test.aihub.example.com',
    jti,
    validUntil: new Date(Date.now() + 960_000),
  };
}

export interface TestAuthOverridesOptions {
  userId?: string;
  validToken?: string;
  reissuedToken?: string;
  verifier?: UserAccessTokenVerifierPort;
  authMocks?: TestAuthMocks;
}

export interface TestAuthMocks {
  tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort>;
  verifier: UserAccessTokenVerifierPort;
  userAccounts: Pick<UserAccountRepositoryPort, 'findUserAccountStatus'>;
  revocations: UserAccessTokenRevocationRecordPort;
}

export interface InitOrganizationTestAppOptions {
  requestId?: string;
  securityHeaders?: boolean;
}

export function createTestAuthMocks(
  options: TestAuthOverridesOptions = {},
): TestAuthMocks {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const validToken = options.validToken ?? DEFAULT_VALID_TOKEN;
  const reissuedToken = options.reissuedToken ?? DEFAULT_REISSUED_TOKEN;

  const tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort> = {
    issue: jest.fn(async (_userId: string) => ({
      token: reissuedToken,
      expiresIn: 900,
    })),
  };
  const verifier: UserAccessTokenVerifierPort = options.verifier ?? {
    verify: async (token: string) => {
      if (token !== validToken) {
        throw new Error('invalid token');
      }
      return stubVerifiedUserAccessToken(userId, 'jti_01');
    },
  };
  const userAccounts: Pick<UserAccountRepositoryPort, 'findUserAccountStatus'> =
    {
      findUserAccountStatus: async () => 'active',
    };

  return {
    tokenIssuer,
    verifier,
    userAccounts,
    revocations: NO_USER_ACCESS_TOKEN_REVOCATIONS,
  };
}

export function createMockApiKeyCache(): jest.Mocked<ApiKeyCachePort> {
  return {
    get: jest.fn(),
    set: jest.fn(),
    setMiss: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockOrganizationApiKeyPort(
  overrides: Partial<jest.Mocked<OrganizationApiKeyPort>> = {},
): jest.Mocked<OrganizationApiKeyPort> {
  return {
    createApiKey: jest.fn(),
    listApiKeys: jest.fn().mockResolvedValue([]),
    rotateApiKey: jest.fn(),
    revokeApiKey: jest.fn(),
    ...overrides,
  };
}

export class OrganizationAdmissionHarness {
  callerRole: OrganizationMembershipRole = 'owner';
  callerStatus: OrganizationMembershipStatus = 'active';
  callerMembershipExists = true;
  organizationStatus: OrganizationStatus = 'active';

  readonly membership: jest.Mocked<OrganizationMembershipPort>;

  constructor() {
    this.membership = {
      resolveMembership: jest.fn(async ({ organizationId, userId }) => {
        if (!this.callerMembershipExists) {
          return { kind: 'missing' as const };
        }
        const stateKind =
          this.callerStatus === 'active'
            ? ('active' as const)
            : ('disabled' as const);
        return {
          kind: stateKind,
          membership: {
            organizationId,
            userId,
            organizationStatus: this.organizationStatus,
            role: this.callerRole,
            status: this.callerStatus,
          },
        };
      }),
      listRoster: jest.fn().mockResolvedValue({ organizations: [] }),
      changeRole: jest.fn().mockResolvedValue(undefined),
      disable: jest.fn().mockResolvedValue(undefined),
      transfer: jest.fn().mockResolvedValue(undefined),
    };
  }

  reset(): void {
    this.callerRole = 'owner';
    this.callerStatus = 'active';
    this.callerMembershipExists = true;
    this.organizationStatus = 'active';
  }

  readDenialCases(): ReadAdmissionDenialCase[] {
    return [
      [
        'no membership in the organization',
        () => {
          this.callerMembershipExists = false;
        },
      ],
      [
        'a disabled membership',
        () => {
          this.callerStatus = 'disabled';
        },
      ],
      [
        'an ordinary member of an active organization',
        () => {
          this.callerRole = 'member';
        },
      ],
      [
        'an owner of a suspended organization',
        () => {
          this.organizationStatus = 'suspended';
        },
      ],
    ];
  }

  mutationDenialCases(
    mockUnavailable: () => void,
  ): MutationAdmissionDenialCase[] {
    return [
      [
        'no membership in the organization',
        () => {
          this.callerMembershipExists = false;
        },
        false,
      ],
      [
        'a disabled membership',
        () => {
          this.callerStatus = 'disabled';
        },
        false,
      ],
      [
        'an ordinary member of an active organization',
        () => {
          this.callerRole = 'member';
        },
        false,
      ],
      [
        'an owner of a suspended organization',
        () => {
          this.organizationStatus = 'suspended';
        },
        false,
      ],
      [
        'an organization suspended inside the transaction',
        mockUnavailable,
        true,
      ],
    ];
  }
}

export function applyTestAuthModuleOverrides(
  builder: TestingModuleBuilder,
  authOptions: TestAuthOverridesOptions = {},
): TestingModuleBuilder {
  const auth = authOptions.authMocks ?? createTestAuthMocks(authOptions);
  return builder
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(auth.verifier)
    .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
    .useValue(auth.tokenIssuer)
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(auth.userAccounts)
    .overrideProvider(USER_ACCESS_TOKEN_REVOCATION_RECORD)
    .useValue(auth.revocations);
}

export function applyOrganizationAdmissionModuleOverrides(
  builder: TestingModuleBuilder,
  admission: OrganizationAdmissionHarness,
  authOptions: TestAuthOverridesOptions = {},
): TestingModuleBuilder {
  builder
    .overrideProvider(ORGANIZATION_MEMBERSHIP)
    .useValue(admission.membership);
  return applyTestAuthModuleOverrides(builder, authOptions);
}

export async function initOrganizationTestApp(
  moduleRef: TestingModule,
  options: InitOrganizationTestAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      genReqId: () => options.requestId ?? DEFAULT_REQUEST_ID,
    }),
  );
  if (options.securityHeaders) {
    registerSecurityHeaders(app.getHttpAdapter().getInstance());
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export function expectAuthorizationDenial(
  response: { statusCode: number; json<T = unknown>(): T },
  expected: AuthorizationDenialExpectation,
): void {
  expect({
    status: response.statusCode,
    body: response.json<unknown>(),
  }).toEqual({
    status: 403,
    body: {
      error: {
        code: 'FORBIDDEN',
        message: expected.message,
        request_id: expected.requestId ?? DEFAULT_REQUEST_ID,
        retryable: false,
      },
    },
  });
}
