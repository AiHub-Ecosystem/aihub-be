import { Value } from '@sinclair/typebox/value';

import {
  type SandboxDemoKeyValidationResponse,
  SandboxDemoKeyValidationResponseSchema,
} from './demo-key-validation';

const RESPONSE: SandboxDemoKeyValidationResponse = {
  valid: true,
  environment: 'sandbox',
  scope: 'speaking.grade',
  user_identity_mode: 'declared_id',
  allowance: {
    monthly_limit: 5,
    reserved: 0,
    shared_monthly_limit: 500,
    shared_reserved: 0,
  },
};

describe('SandboxDemoKeyValidationResponseSchema', () => {
  it('accepts both identity modes the demo can present', () => {
    expect(Value.Check(SandboxDemoKeyValidationResponseSchema, RESPONSE)).toBe(
      true,
    );
    for (const mode of ['signed_assertion', 'declared_id'] as const) {
      expect(
        Value.Check(SandboxDemoKeyValidationResponseSchema, {
          ...RESPONSE,
          user_identity_mode: mode,
        }),
      ).toBe(true);
    }
  });

  it('accepts the Production shape, where no allowance applies', () => {
    expect(
      Value.Check(SandboxDemoKeyValidationResponseSchema, {
        ...RESPONSE,
        environment: 'production',
        allowance: null,
      }),
    ).toBe(true);
  });

  it('rejects an identity mode outside the published set', () => {
    for (const mode of ['none', 'SIGNED_ASSERTION', '', null]) {
      expect(
        Value.Check(SandboxDemoKeyValidationResponseSchema, {
          ...RESPONSE,
          user_identity_mode: mode,
        }),
      ).toBe(false);
    }
  });

  it('rejects an unspecified field rather than passing it through', () => {
    expect(
      Value.Check(SandboxDemoKeyValidationResponseSchema, {
        ...RESPONSE,
        issuer: 'https://acme.edu',
      }),
    ).toBe(false);
    const { user_identity_mode: _mode, ...withoutMode } = RESPONSE;
    expect(
      Value.Check(SandboxDemoKeyValidationResponseSchema, withoutMode),
    ).toBe(false);
  });
});
