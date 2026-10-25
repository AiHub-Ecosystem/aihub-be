import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS } from '@/catalog/operation-id';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';
import { WEB_SESSION_CLIENT_SECRET_HEADER } from '@/common/http/client-secret-header';
import { PUBLIC_API_SERVERS } from '@/config/runtime-configuration';
import { OrganizationIdSchema } from '@/contracts/organization/organization-id';
import { REFRESH_COOKIE_NAME } from '@/modules/auth/presentation/refresh-cookie';
import { buildErrorResponses } from './openapi-error-responses';
import { localAuthPathItems } from './openapi-local-auth-path-items';
import {
  organizationAuditEventPathItem,
  organizationIdentityConfigPathItem,
  organizationMembershipListPathItem,
  organizationMembershipMutationPathItem,
  organizationMembershipTransferPathItem,
  organizationRosterPathItem,
} from './openapi-organization-access-path-items';
import {
  organizationApiKeyItemPathItem,
  organizationApiKeyPathItem,
  organizationApiKeyRotatePathItem,
  organizationInvitationAcceptPathItem,
  organizationInvitationItemPathItem,
  organizationInvitationPathItem,
  organizationItemPathItem,
  organizationPathItem,
} from './openapi-organization-path-items';
import {
  avatarCompletePathItem,
  avatarItemPathItem,
  avatarUploadPathItem,
  sandboxAssertionPathItem,
  sandboxDemoKeyValidationPathItem,
  speakingAudioUploadPathItems,
  speakingQuestionsPathItem,
  writingChartUploadPathItems,
} from './openapi-product-path-items';
import {
  CORRELATION_ID_PARAMETER,
  USER_IDENTITY_PARAMETER,
  errorsByStatus,
  operationToPathItem,
  routePathOf,
} from './openapi-shared';
import { webSessionPathItems } from './openapi-web-session-path-items';

const OPENAPI_VERSION = '3.1.0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function addHeadOperations(paths: Record<string, unknown>): void {
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem) || !isRecord(pathItem.get) || pathItem.head) {
      continue;
    }

    const getOperation = pathItem.get;
    const getResponses = isRecord(getOperation.responses)
      ? getOperation.responses
      : {};
    const responses = Object.fromEntries(
      Object.entries(getResponses).map(([status, response]) => {
        const headers = isRecord(response) ? response.headers : undefined;
        return [
          status,
          {
            description:
              status === '200'
                ? 'Success; same headers as GET, without a response body.'
                : 'Same status as GET, without a response body.',
            ...(headers === undefined ? {} : { headers }),
          },
        ];
      }),
    );

    pathItem.head = {
      ...getOperation,
      operationId: `${String(getOperation.operationId)}.head`,
      summary: 'Retrieve response headers',
      description:
        'Returns the same status and headers as GET without a response body.',
      responses,
    };
  }
}

export function buildOpenApiDocument(version: string): unknown {
  const paths: Record<string, unknown> = {};
  const groupedErrors = errorsByStatus();

  for (const operationId of OPERATION_IDS) {
    const operation = OPERATION_CATALOG[operationId];
    paths[operation.path] = {
      ...(paths[operation.path] as Record<string, unknown> | undefined),
      ...operationToPathItem(operationId, operation, groupedErrors),
    };
  }

  paths[routePathOf('sandbox.assertions.mint')] =
    sandboxAssertionPathItem(groupedErrors);
  paths[routePathOf('sandbox.demo-key.validate')] =
    sandboxDemoKeyValidationPathItem(groupedErrors);
  paths[routePathOf('speaking.questions')] = speakingQuestionsPathItem();
  Object.assign(paths, speakingAudioUploadPathItems());
  Object.assign(paths, writingChartUploadPathItems());
  paths[routePathOf('me.avatar.uploads.create')] = avatarUploadPathItem();
  paths[routePathOf('me.avatar.uploads.complete')] = avatarCompletePathItem();
  paths[routePathOf('me.avatar.remove')] = avatarItemPathItem();
  paths[routePathOf('organizations.create')] = organizationPathItem();
  paths[routePathOf('organizations.rename')] = organizationItemPathItem();
  paths[routePathOf('organizations.me.members.list')] =
    organizationRosterPathItem();
  paths[routePathOf('organizations.members.list')] =
    organizationMembershipListPathItem();
  paths[routePathOf('organizations.invitations.list')] =
    organizationInvitationPathItem();
  paths[routePathOf('organizations.invitations.revoke')] =
    organizationInvitationItemPathItem();
  paths[routePathOf('organizations.invitations.accept')] =
    organizationInvitationAcceptPathItem();
  paths[routePathOf('organizations.members.change_role')] =
    organizationMembershipMutationPathItem();
  paths[routePathOf('organizations.members.transfer')] =
    organizationMembershipTransferPathItem();
  paths[routePathOf('organizations.apiKeys.list')] =
    organizationApiKeyPathItem();
  paths[routePathOf('organizations.apiKeys.revoke')] =
    organizationApiKeyItemPathItem();
  paths[routePathOf('organizations.apiKeys.rotate')] =
    organizationApiKeyRotatePathItem();
  paths[routePathOf('organizations.identityConfig.read')] =
    organizationIdentityConfigPathItem();
  paths[routePathOf('organizations.auditEvents.list')] =
    organizationAuditEventPathItem();
  Object.assign(paths, localAuthPathItems());
  Object.assign(paths, webSessionPathItems());
  addHeadOperations(paths);

  const errorResponses = buildErrorResponses(groupedErrors);

  for (const route of Object.values(PUBLIC_ROUTES) as PublicRouteDef[]) {
    if (route.sunset === undefined) continue;
    const item = paths[route.path] as Record<string, unknown> | undefined;
    if (item !== undefined) {
      item['x-deprecated-sunset'] = route.sunset;
    }
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'AIHUB API',
      version,
    },
    servers: PUBLIC_API_SERVERS.map(({ hostname, description }) => ({
      url: `https://${hostname}`,
      description,
    })),
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'Organization credential. Identifies the organization; does not identify an individual end user.',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'User Access JWT for protected user-facing routes.',
        },
        RefreshCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: REFRESH_COOKIE_NAME,
          description:
            'Host-only Secure HttpOnly cookie containing the opaque refresh credential.',
        },
        BffClientSecret: {
          type: 'apiKey',
          in: 'header',
          name: WEB_SESSION_CLIENT_SECRET_HEADER,
          description:
            'Server-to-server only, Customer Web BFF. Static client secret proving the caller is the AIHUB-owned Customer Web backend. Not a browser credential and not an Organization key: a browser never sends it, and these routes are not for a browser to call.',
        },
      },
      parameters: {
        CorrelationId: CORRELATION_ID_PARAMETER,
        UserIdentity: USER_IDENTITY_PARAMETER,
      },
      schemas: { OrganizationId: OrganizationIdSchema },
      responses: errorResponses,
    },
    paths,
  };
}
