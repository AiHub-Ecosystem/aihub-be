import { MfaRequiredResponseSchema } from '@/contracts/auth/local-auth';
import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import { errorResponse, errorResponseSchema } from './openapi-error-responses';
import { publishedLocalAuthRequestSchema } from './openapi-local-auth-path-items';
import {
  routeErrorResponsesOf,
  routeIdentityScopeOf,
  routePathOf,
  routeSchemaOf,
  routeSecurityOf,
} from './openapi-shared';

/** Both codes the Web Session route can answer 401 with, and nothing finer. */
function webSessionRefusedResponse(): Record<string, unknown> {
  return {
    description:
      'Client secret missing or wrong, or the email and password are not an active account',
    content: {
      'application/json': {
        schema: errorResponseSchema([
          'UNAUTHORIZED',
          'AUTH_CREDENTIALS_INVALID',
        ]),
      },
    },
  };
}

/**
 * The exchange's two 401 codes, and nothing finer: a missing or wrong client
 * secret, and the one generic code every unusable session answers.
 */
function webSessionExchangeRefusedResponse(): Record<string, unknown> {
  return {
    description:
      'Client secret missing or wrong, or the Web Session token is expired, revoked, unknown, malformed, or belongs to an account that is not active',
    content: {
      'application/json': {
        schema: errorResponseSchema([
          'UNAUTHORIZED',
          'AUTH_WEB_SESSION_INVALID',
        ]),
      },
    },
  };
}

/**
 * The Customer Web BFF route group. A browser never calls these: the caller is
 * a server holding the BFF client secret, and the Web Session token comes back
 * in the body rather than in a cookie AIHUB could not set for another host.
 */
export function webSessionPathItems(): Record<string, Record<string, unknown>> {
  const createResponses = {
    '201': {
      description:
        'Web Session created. The opaque token travels in this body, never in a cookie: the Customer Web BFF stores it in its own HttpOnly cookie.',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
      },
      content: {
        'application/json': { schema: CreateWebSessionResponseSchema },
      },
    },
    '202': {
      description:
        'Password accepted; submit the same email/password and a TOTP or unused recovery code in the next request. Customer Web keeps the password only in transient form memory, never local or session storage.',
      headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      },
      content: {
        'application/json': { schema: MfaRequiredResponseSchema },
      },
    },
    ...routeErrorResponsesOf('auth.web_sessions.create'),
    // One generic 401 covers a missing or wrong client secret and a wrong,
    // unknown, pending-verification, or disabled credential alike: the route
    // cannot tell them apart, so the document must not look as though it can.
    '401': webSessionRefusedResponse(),
  };

  return {
    [routePathOf('auth.web_sessions.create')]: {
      post: {
        operationId: 'auth.web_sessions.create',
        summary: 'Create a Web Session from an email and password',
        description:
          'Server-to-server only, Customer Web BFF. AIHUB stores only the token hash, never sets a cookie for this route, and applies the same credential checks and login rate limits as POST /v1/auth/login. When MFA is enabled, a missing code returns 202 MFA_REQUIRED without creating a Web Session; the next request resubmits email, password, and TOTP or recovery code. Customer Web keeps the password only in transient form memory and clears it when the flow ends.',
        ...routeIdentityScopeOf('auth.web_sessions.create'),
        ...routeSecurityOf('auth.web_sessions.create'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: publishedLocalAuthRequestSchema(
                routeSchemaOf('auth.web_sessions.create', 'request'),
              ),
            },
          },
        },
        responses: createResponses,
      },
    },
    [routePathOf('auth.web_sessions.verification')]: {
      post: {
        operationId: 'auth.web_sessions.verification',
        summary: 'Create a Web Session from a verification token',
        description:
          'Server-to-server only, Customer Web BFF. The verification token and the Signup Browser Binding received at signup: a binding that does not match verifies the email and answers 204 with no session, and one token creates at most one session whichever route reaches it first. Applies the verification attempt budget per token hash, so Customer Web BFF users behind a shared proxy address do not consume one shared IP counter.',
        ...routeIdentityScopeOf('auth.web_sessions.verification'),
        ...routeSecurityOf('auth.web_sessions.verification'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              // No `publishedLocalAuthRequestSchema`: the optional password
              // (ADR-0123) is checked against the stored registration, not
              // against the password policy, so there is no policy to re-state
              // for a generated client.
              schema: routeSchemaOf(
                'auth.web_sessions.verification',
                'request',
              ),
            },
          },
        },
        responses: {
          '201': createResponses['201'],
          ...routeErrorResponsesOf('auth.web_sessions.verification'),
          '400': errorResponse(
            'Malformed request, invalid verification token, or a registration password that is missing or does not match',
            [
              'INVALID_REQUEST',
              'AUTH_VERIFICATION_TOKEN_INVALID',
              'AUTH_VERIFICATION_PASSWORD_INVALID',
            ],
          ),
          '401': errorResponse('Client secret missing or wrong', [
            'UNAUTHORIZED',
          ]),
          // 204 is not an error: the email is verified and no session was
          // granted, which is the same answer POST /v1/auth/verify-email gives.
          '204': { description: 'Email verified; no Web Session created.' },
        },
      },
    },
    [routePathOf('auth.web_sessions.exchange')]: {
      post: {
        operationId: 'auth.web_sessions.exchange',
        summary: 'Exchange a Web Session for a User Access JWT',
        description:
          'Server-to-server only, Customer Web BFF. The stateless exchange: every call signs a fresh User Access JWT through the same issuer as POST /v1/auth/login, with the same claims, audience, issuer, and 15-minute lifetime, and AIHUB stores nothing for it. The Web Session token travels in this body and nowhere else — a token offered in a cookie, an authorization header, or a query parameter is refused. A successful exchange slides the Web Session expiry 30 days forward and writes nothing when the last renewal is less than about an hour old, so concurrent exchanges need no lock and no shared store. AIHUB keeps no record of an issued JWT, so a BFF may cache one in process until shortly before it expires; a JWT signed before a logout therefore stays valid for up to 15 minutes.',
        ...routeIdentityScopeOf('auth.web_sessions.exchange'),
        ...routeSecurityOf('auth.web_sessions.exchange'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.web_sessions.exchange', 'request'),
            },
          },
        },
        responses: {
          '200': {
            description:
              'User Access JWT issued. Same envelope as POST /v1/auth/login; no cookie is set for this route.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
            content: {
              'application/json': {
                schema: routeSchemaOf('auth.web_sessions.exchange', 'response'),
              },
            },
          },
          ...routeErrorResponsesOf('auth.web_sessions.exchange'),
          // One code for every session that cannot be exchanged — expired,
          // revoked, unknown, malformed, or a non-active account — so the BFF
          // clears the cookie and asks for a sign-in without learning which.
          '401': webSessionExchangeRefusedResponse(),
        },
      },
    },
    [routePathOf('auth.web_sessions.logout')]: {
      post: {
        operationId: 'auth.web_sessions.logout',
        summary: 'Revoke a Web Session',
        description:
          'Server-to-server only, Customer Web BFF. Idempotent and quiet: a valid, already-revoked, unknown, expired, and malformed token all answer the same bodyless 204, so a stale tab or a repeated logout never shows a confusing error and no caller can probe which sessions exist. Only the presented session is revoked — the account’s other devices stay signed in. The Web Session token travels in this body and nowhere else; offered in a cookie, an authorization header, or a query parameter it is read from nowhere, so nothing is revoked. A password reset is what ends every Web Session of an account; there is no log-out-all-devices route. A JWT signed before a logout stays valid for up to 15 minutes.',
        ...routeIdentityScopeOf('auth.web_sessions.logout'),
        ...routeSecurityOf('auth.web_sessions.logout'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.web_sessions.logout', 'request'),
            },
          },
        },
        responses: {
          '204': {
            description:
              'Session revoked, or already revoked, unknown, or expired. One bodyless answer for every case, and no cookie is set for this route.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
          },
          ...routeErrorResponsesOf('auth.web_sessions.logout'),
          // The client secret, and nothing about the session: logout has no
          // session failure to report, so a missing or wrong secret is the only
          // 401 here.
          '401': errorResponse('Client secret missing or wrong', [
            'UNAUTHORIZED',
          ]),
        },
      },
    },
  };
}
