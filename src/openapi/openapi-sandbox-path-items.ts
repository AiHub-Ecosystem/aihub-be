import { Type } from '@sinclair/typebox';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { ErrorCode } from '@/common/errors/error-code';
import type { HttpStatus } from '@/common/errors/error-registry';
import { MintSandboxAssertionResponseSchema } from '@/contracts/sandbox/assertion';
import {
  routeCacheControlHeadersOf,
  routeErrorResponsesOf,
  routeIdentityScopeOf,
  routeSchemaOf,
  routeSecurityOf,
  routeSuccessKeyOf,
} from './openapi-shared';

// Manual: the shared builder cannot express the sandbox's request_id-only success envelope.
export function sandboxAssertionPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const id = 'sandbox.assertions.mint' as const;
  const responses: Record<string, unknown> = {
    [routeSuccessKeyOf(id)]: {
      description: 'A freshly signed assertion for the sandbox organization',
      content: {
        'application/json': {
          schema: Type.Object(
            {
              data: MintSandboxAssertionResponseSchema,
              meta: Type.Object(
                {
                  request_id: Type.String({
                    pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
                  }),
                },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        },
      },
    },
  };

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Mint a sandbox user assertion',
      description: [
        'Issues a short-lived user assertion for the sandbox organization, so that exercising the API does not require holding an organization signing key.',
        'Available only to API keys belonging to a configured sandbox organization; every other key is refused. Deployments with no sandbox configured answer 404.',
        'This is not the integration pattern for a customer with their own backend. Such a customer signs assertions from their own identity provider and never calls this route.',
      ].join('\n\n'),
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        ...responses,
        ...routeErrorResponsesOf(id, groupedErrors),
      },
    },
  };
}

// Manual: the shared builder cannot express the trusted BFF header and narrower success envelope.
export function sandboxDemoKeyValidationPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const id = 'sandbox.demo-key.validate' as const;
  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Validate a demo key for the selected environment',
      description: [
        'Customer Web BFF only. Checks that the active API key is bound to the selected environment and carries the requested Writing or Speaking grading scope, then reports which user-identity input the demo collects next.',
        '`user_identity_mode` is `signed_assertion` when the Organization has an active Identity Configuration and `declared_id` otherwise. It selects the browser input only and exposes no Identity Configuration detail.',
        'This route does not dispatch to an AI service and does not consume grading quota. It is rate-limited and advisory; each upload and grading operation authenticates the key again and enforces the Organization identity policy. Active Identity Configuration requires a valid Signed User Assertion; otherwise, the Declared User ID flow applies.',
      ].join('\n\n'),
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'X-AIHUB-Visitor-IP',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'ip' },
          description:
            'Trusted visitor IP forwarded by the authenticated Customer Web BFF for per-visitor failed-key protection.',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Key is eligible for the requested live demo skill',
          headers: routeCacheControlHeadersOf(id),
          content: {
            'application/json': {
              schema: Type.Object(
                {
                  data: routeSchemaOf(id, 'response'),
                  meta: Type.Object(
                    {
                      request_id: Type.String({
                        pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
                      }),
                    },
                    { additionalProperties: false },
                  ),
                },
                { additionalProperties: false },
              ),
            },
          },
        },
        ...routeErrorResponsesOf(id, groupedErrors),
      },
    },
  };
}
