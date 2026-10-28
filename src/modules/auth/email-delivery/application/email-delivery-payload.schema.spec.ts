import { Value } from '@sinclair/typebox/value';

import {
  ApiKeyNearExpiryNotificationPayloadSchema,
  AuthEmailDeliveryPayloadSchema,
  MfaSecurityNotificationPayloadSchema,
  OrganizationInviteEmailDeliveryPayloadSchema,
} from './email-delivery-payload';

const AUTH = {
  email: 'person@example.com',
  token: 'token-1',
  expiresAt: '2026-10-29T00:00:00.000Z',
};
const INVITATION = {
  ...AUTH,
  organizationName: 'Resonance',
  role: 'member',
};
const MFA = { email: 'person@example.com' };
const NEAR_EXPIRY = {
  organizationId: 'org_1',
  userAccountId: 'usr_1',
  apiKeyIds: ['key_1', 'key_2'],
};

describe('stored email delivery payload schemas', () => {
  it.each([
    ['an authentication email', AuthEmailDeliveryPayloadSchema, AUTH],
    [
      'an invitation',
      OrganizationInviteEmailDeliveryPayloadSchema,
      { ...INVITATION, inviterUsername: 'ada' },
    ],
    [
      'an invitation without an inviter',
      OrganizationInviteEmailDeliveryPayloadSchema,
      INVITATION,
    ],
    ['an MFA notification', MfaSecurityNotificationPayloadSchema, MFA],
    [
      'an API key near-expiry notice',
      ApiKeyNearExpiryNotificationPayloadSchema,
      NEAR_EXPIRY,
    ],
  ] as const)('accepts %s', (_name, schema, payload) => {
    expect(Value.Check(schema, payload)).toBe(true);
  });

  it.each([
    ['an authentication email', AuthEmailDeliveryPayloadSchema, AUTH],
    ['an invitation', OrganizationInviteEmailDeliveryPayloadSchema, INVITATION],
    ['an MFA notification', MfaSecurityNotificationPayloadSchema, MFA],
    [
      'an API key near-expiry notice',
      ApiKeyNearExpiryNotificationPayloadSchema,
      NEAR_EXPIRY,
    ],
  ] as const)(
    'ignores a member a newer release added to %s',
    (_name, schema, payload) => {
      expect(Value.Check(schema, { ...payload, addedLater: { n: 1 } })).toBe(
        true,
      );
    },
  );

  it.each([
    ['email', { ...AUTH, email: undefined }],
    ['token', { ...AUTH, token: undefined }],
    ['expiresAt', { ...AUTH, expiresAt: undefined }],
    ['an empty email', { ...AUTH, email: '' }],
    ['an empty token', { ...AUTH, token: '' }],
    ['a numeric expiresAt', { ...AUTH, expiresAt: 1 }],
  ])('rejects an authentication email with %s wrong', (_name, payload) => {
    expect(Value.Check(AuthEmailDeliveryPayloadSchema, payload)).toBe(false);
  });

  it.each([
    [
      'a missing organization name',
      { ...INVITATION, organizationName: undefined },
    ],
    ['an empty organization name', { ...INVITATION, organizationName: '' }],
    ['a missing role', { ...INVITATION, role: undefined }],
    ['a numeric role', { ...INVITATION, role: 3 }],
    ['an unknown role', { ...INVITATION, role: 'auditor' }],
    ['an empty inviter', { ...INVITATION, inviterUsername: '' }],
    ['a numeric inviter', { ...INVITATION, inviterUsername: 4 }],
    ['a missing token', { ...INVITATION, token: undefined }],
  ])('rejects an invitation with %s', (_name, payload) => {
    expect(
      Value.Check(OrganizationInviteEmailDeliveryPayloadSchema, payload),
    ).toBe(false);
  });

  it.each([
    ['no email', {}],
    ['a numeric email', { email: 42 }],
    ['an empty email', { email: '' }],
  ])('rejects an MFA notification with %s', (_name, payload) => {
    expect(Value.Check(MfaSecurityNotificationPayloadSchema, payload)).toBe(
      false,
    );
  });

  it.each([
    ['no organization', { ...NEAR_EXPIRY, organizationId: undefined }],
    ['an empty organization', { ...NEAR_EXPIRY, organizationId: '' }],
    ['no user account', { ...NEAR_EXPIRY, userAccountId: undefined }],
    ['no key list', { ...NEAR_EXPIRY, apiKeyIds: undefined }],
    ['an empty key list', { ...NEAR_EXPIRY, apiKeyIds: [] }],
    ['a non-string key id', { ...NEAR_EXPIRY, apiKeyIds: [1] }],
    ['an empty key id', { ...NEAR_EXPIRY, apiKeyIds: [''] }],
    ['a key list that is not an array', { ...NEAR_EXPIRY, apiKeyIds: 'key_1' }],
  ])('rejects an API key near-expiry notice with %s', (_name, payload) => {
    expect(
      Value.Check(ApiKeyNearExpiryNotificationPayloadSchema, payload),
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'text'],
  ])('rejects %s for every kind', (_name, payload) => {
    for (const schema of [
      AuthEmailDeliveryPayloadSchema,
      OrganizationInviteEmailDeliveryPayloadSchema,
      MfaSecurityNotificationPayloadSchema,
      ApiKeyNearExpiryNotificationPayloadSchema,
    ]) {
      expect(Value.Check(schema, payload)).toBe(false);
    }
  });
});
