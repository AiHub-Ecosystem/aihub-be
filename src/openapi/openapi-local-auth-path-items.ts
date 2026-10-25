import { type TObject, type TSchema, Type } from '@sinclair/typebox';

import type { PublicRouteId } from '@/catalog/public-routes';
import {
  ForgotPasswordResponseSchema,
  LoginResponseSchema,
  MfaRequiredResponseSchema,
  PASSWORD_POLICY_DESCRIPTION,
  RegisterResponseSchema,
} from '@/contracts/auth/local-auth';
import {
  BeginMfaEnrollmentResponseSchema,
  ConfirmMfaEnrollmentResponseSchema,
} from '@/contracts/auth/mfa';
import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
} from '@/modules/auth/domain/local-auth';
import { errorResponse, errorResponseSchema } from './openapi-error-responses';
import {
  routeErrorResponsesOf,
  routeIdentityScopeOf,
  routePathOf,
  routeSchemaOf,
  routeSecurityOf,
} from './openapi-shared';

function refreshInvalidResponse(): Record<string, unknown> {
  return {
    description: 'Refresh credential is missing, invalid, expired, or revoked',
    content: {
      'application/json': {
        schema: errorResponseSchema(['AUTH_REFRESH_TOKEN_INVALID']),
      },
    },
  };
}

export function publishedLocalAuthRequestSchema(schema: TSchema): TSchema {
  // The three routes that publish a password re-state the policy so a generated
  // client enforces it, which means restating the object rather than merging a
  // flag. A non-object schema here is a contract bug, not a document one.
  if (!('properties' in schema)) {
    throw new Error('a published local-auth request must be an object schema');
  }

  const objectSchema = schema as TObject;
  const options =
    objectSchema.additionalProperties === undefined
      ? {}
      : { additionalProperties: objectSchema.additionalProperties };

  return Type.Object(
    {
      ...objectSchema.properties,
      password: Type.String({
        minLength: PASSWORD_MIN_CODE_POINTS,
        maxLength: PASSWORD_MAX_CODE_POINTS,
        description: PASSWORD_POLICY_DESCRIPTION,
      }),
    },
    options,
  );
}

export function localAuthPathItems(): Record<string, Record<string, unknown>> {
  // Keep auth responses intentionally narrow: these routes do not carry API
  // key, assertion, downstream, or idempotency behavior. The success status,
  // the error statuses, and the security entry come from the registry; the
  // response prose stays here.
  const registerResponses = {
    '201': {
      description: 'Account created and pending email verification',
      content: { 'application/json': { schema: RegisterResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.register'),
  };
  const loginResponses = {
    '200': {
      description: 'Access token issued',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'The host-only refresh cookie for the new session.',
          schema: { type: 'string' },
        },
      },
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    '202': {
      description:
        'Password accepted; TOTP or an unused recovery code is required before a Refresh Session is created.',
      headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      },
      content: { 'application/json': { schema: MfaRequiredResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.login'),
  };
  const verifyResponses = {
    '200': {
      ...loginResponses['200'],
      description:
        'Verification Sign-in (ADR-0054): the request carried the Signup Browser Binding of the browser that requested this token, which had not signed in yet. Same session as a login.',
    },
    '204': {
      description:
        'Email verified without signing in: no binding, another browser, or the token already signed in. Re-submitting the same unexpired token that activated the still-active account also succeeds.',
    },
    ...routeErrorResponsesOf('auth.verify_email'),
    '400': errorResponse(
      'Malformed request, invalid verification token, or (ADR-0123) a registration password that is missing for a token that needs it or does not match',
      [
        'INVALID_REQUEST',
        'AUTH_VERIFICATION_TOKEN_INVALID',
        'AUTH_VERIFICATION_PASSWORD_INVALID',
      ],
    ),
  };
  const resendResponses = {
    '202': { description: 'Verification resend accepted' },
    ...routeErrorResponsesOf('auth.resend_verification'),
  };
  const forgotPasswordResponses = {
    '202': {
      description: 'Password recovery request accepted',
      content: {
        'application/json': { schema: ForgotPasswordResponseSchema },
      },
    },
    ...routeErrorResponsesOf('auth.forgot_password'),
  };
  const resetPasswordResponses = {
    '204': {
      description: 'Password reset and refresh sessions revoked',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'An expired host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
    },
    ...routeErrorResponsesOf('auth.reset_password'),
  };
  const refreshResponses = {
    '200': {
      description: 'Access token issued and refresh cookie rotated',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'The rotated host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.refresh'),
    '401': refreshInvalidResponse(),
  };
  const logoutResponses = {
    '204': {
      description: 'Refresh session revoked and cookie cleared',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'An expired host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
    },
    ...routeErrorResponsesOf('auth.logout'),
  };
  const currentUserResponses = {
    '200': {
      description: 'The authenticated AIHUB User Account profile',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
      },
      content: {
        'application/json': {
          schema: routeSchemaOf('me.profile.read', 'response'),
        },
      },
    },
    ...routeErrorResponsesOf('me.profile.read'),
  };

  const operation = (
    operationId: PublicRouteId,
    summary: string,
    schema: TSchema,
    responses: Record<string, unknown>,
    requestBodyRequired = true,
  ): Record<string, unknown> => ({
    post: {
      operationId,
      summary,
      ...routeIdentityScopeOf(operationId),
      ...routeSecurityOf(operationId),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: requestBodyRequired,
        content: { 'application/json': { schema } },
      },
      responses,
    },
  });

  return {
    [routePathOf('auth.register')]: operation(
      'auth.register',
      'Register a local AIHUB account',
      publishedLocalAuthRequestSchema(
        routeSchemaOf('auth.register', 'request'),
      ),
      registerResponses,
    ),
    [routePathOf('auth.login')]: operation(
      'auth.login',
      'Issue a User Access JWT',
      publishedLocalAuthRequestSchema(routeSchemaOf('auth.login', 'request')),
      loginResponses,
    ),
    [routePathOf('auth.mfa.enrollment')]: {
      post: {
        operationId: 'auth.mfa.enrollment',
        summary: 'Begin TOTP enrollment',
        description:
          'Requires a fresh password. The encrypted pending secret is disclosed only by this no-store response; confirm it before the factor is enabled.',
        ...routeIdentityScopeOf('auth.mfa.enrollment'),
        ...routeSecurityOf('auth.mfa.enrollment'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.mfa.enrollment', 'request'),
            },
          },
        },
        responses: {
          '200': {
            description:
              'Pending authenticator secret and otpauth URI; shown before confirmation only.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
            content: {
              'application/json': { schema: BeginMfaEnrollmentResponseSchema },
            },
          },
          ...routeErrorResponsesOf('auth.mfa.enrollment'),
        },
      },
    },
    [routePathOf('auth.mfa.enrollment.confirm')]: {
      post: {
        operationId: 'auth.mfa.enrollment.confirm',
        summary: 'Confirm TOTP enrollment',
        description:
          'A valid code enables the factor and returns eight recovery codes once. Their hashes and the security notification are committed in the same transaction.',
        ...routeIdentityScopeOf('auth.mfa.enrollment.confirm'),
        ...routeSecurityOf('auth.mfa.enrollment.confirm'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.mfa.enrollment.confirm', 'request'),
            },
          },
        },
        responses: {
          '200': {
            description:
              'One-time recovery codes. Store them securely; AIHUB cannot show them again.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
            content: {
              'application/json': {
                schema: ConfirmMfaEnrollmentResponseSchema,
              },
            },
          },
          ...routeErrorResponsesOf('auth.mfa.enrollment.confirm'),
        },
      },
    },
    [routePathOf('auth.mfa.remove')]: {
      delete: {
        operationId: 'auth.mfa.remove',
        summary: 'Remove TOTP factor',
        description:
          'Requires a fresh password or TOTP code. Removal ends all Refresh Sessions and Web Sessions; already-issued stateless User Access JWTs remain valid for at most 15 minutes.',
        ...routeIdentityScopeOf('auth.mfa.remove'),
        ...routeSecurityOf('auth.mfa.remove'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.mfa.remove', 'request'),
            },
          },
        },
        responses: {
          '204': {
            description: 'Factor removed and durable sessions revoked.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
          },
          ...routeErrorResponsesOf('auth.mfa.remove'),
        },
      },
    },
    [routePathOf('auth.verify_email')]: operation(
      'auth.verify_email',
      'Verify a local account email address',
      routeSchemaOf('auth.verify_email', 'request'),
      verifyResponses,
    ),
    [routePathOf('auth.resend_verification')]: operation(
      'auth.resend_verification',
      'Request a verification email resend',
      routeSchemaOf('auth.resend_verification', 'request'),
      resendResponses,
    ),
    [routePathOf('auth.forgot_password')]: operation(
      'auth.forgot_password',
      'Request a password reset email',
      routeSchemaOf('auth.forgot_password', 'request'),
      forgotPasswordResponses,
    ),
    [routePathOf('auth.reset_password')]: operation(
      'auth.reset_password',
      'Reset a local account password',
      publishedLocalAuthRequestSchema(
        routeSchemaOf('auth.reset_password', 'request'),
      ),
      resetPasswordResponses,
    ),
    [routePathOf('auth.refresh')]: operation(
      'auth.refresh',
      'Rotate a refresh session and issue a User Access JWT',
      routeSchemaOf('auth.refresh', 'request'),
      refreshResponses,
      false,
    ),
    [routePathOf('auth.logout')]: operation(
      'auth.logout',
      'Revoke the current refresh session',
      routeSchemaOf('auth.logout', 'request'),
      logoutResponses,
      false,
    ),
    [routePathOf('me.profile.read')]: {
      get: {
        operationId: 'me.profile.read',
        summary: 'Read the current AIHUB account profile',
        ...routeIdentityScopeOf('me.profile.read'),
        ...routeSecurityOf('me.profile.read'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        responses: currentUserResponses,
      },
    },
  };
}
