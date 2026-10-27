import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS } from '@/catalog/operation-id';
import {
  PUBLIC_ROUTES,
  type PublicRouteDef,
  type PublicRouteId,
} from '@/catalog/public-routes';
import { WEB_SESSION_CLIENT_SECRET_HEADER } from '@/common/http/client-secret-header';
import { isRecord } from '@/common/is-record';
import { PUBLIC_API_SERVERS } from '@/config/runtime-configuration';
import { OrganizationIdSchema } from '@/contracts/organization/organization-id';
import { REFRESH_COOKIE_NAME } from '@/modules/auth/presentation/refresh-cookie';
import { buildErrorResponses } from './openapi-error-responses';
import { localAuthPathItems } from './openapi-local-auth-path-items';
import { extendPublicResponseSchemas } from './openapi-response-schemas';
import {
  sandboxAssertionPathItem,
  sandboxDemoKeyValidationPathItem,
} from './openapi-sandbox-path-items';
import {
  CORRELATION_ID_PARAMETER,
  USER_IDENTITY_PARAMETER,
  errorsByStatus,
  operationToPathItem,
  publicRouteToPathItem,
  routePathOf,
} from './openapi-shared';
import { webSessionPathItems } from './openapi-web-session-path-items';

const OPENAPI_VERSION = '3.1.0';

function addPublicRoute(
  paths: Record<string, unknown>,
  routeId: PublicRouteId,
): void {
  const path = routePathOf(routeId);
  paths[path] = {
    ...(isRecord(paths[path]) ? paths[path] : {}),
    ...publicRouteToPathItem(routeId),
  };
}

// Manual because a generated HEAD operation needs bodyless copies of each GET response.
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
  addPublicRoute(paths, 'speaking.questions');
  addPublicRoute(paths, 'speaking.audioUploads.create');
  addPublicRoute(paths, 'speaking.audioUploads.refresh');
  addPublicRoute(paths, 'speaking.audioUploads.complete');
  addPublicRoute(paths, 'writing.chartUploads.create');
  addPublicRoute(paths, 'writing.chartUploads.refresh');
  addPublicRoute(paths, 'writing.chartUploads.complete');
  addPublicRoute(paths, 'me.avatar.uploads.create');
  addPublicRoute(paths, 'me.avatar.uploads.complete');
  addPublicRoute(paths, 'me.avatar.read');
  addPublicRoute(paths, 'me.avatar.remove');
  addPublicRoute(paths, 'organizations.create');
  addPublicRoute(paths, 'organizations.rename');
  addPublicRoute(paths, 'organizations.me.members.list');
  addPublicRoute(paths, 'organizations.members.list');
  addPublicRoute(paths, 'organizations.invitations.list');
  addPublicRoute(paths, 'organizations.invitations.create');
  addPublicRoute(paths, 'organizations.invitations.revoke');
  addPublicRoute(paths, 'organizations.invitations.accept');
  addPublicRoute(paths, 'organizations.members.change_role');
  addPublicRoute(paths, 'organizations.members.disable');
  addPublicRoute(paths, 'organizations.members.transfer');
  addPublicRoute(paths, 'organizations.apiKeys.list');
  addPublicRoute(paths, 'organizations.apiKeys.create');
  addPublicRoute(paths, 'organizations.apiKeys.revoke');
  addPublicRoute(paths, 'organizations.apiKeys.rotate');
  addPublicRoute(paths, 'organizations.identityConfig.set');
  addPublicRoute(paths, 'organizations.identityConfig.read');
  addPublicRoute(paths, 'organizations.auditEvents.list');
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

  const document = {
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

  extendPublicResponseSchemas(document);
  return document;
}
