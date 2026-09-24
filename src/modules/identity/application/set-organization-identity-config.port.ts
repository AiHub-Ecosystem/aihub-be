import type {
  SetOrganizationIdentityConfigInput,
  SetOrganizationIdentityConfigResult,
} from './set-organization-identity-config';

export interface SetOrganizationIdentityConfigPort {
  set(
    input: SetOrganizationIdentityConfigInput,
  ): Promise<SetOrganizationIdentityConfigResult>;
}

export const SET_ORGANIZATION_IDENTITY_CONFIG = Symbol(
  'SET_ORGANIZATION_IDENTITY_CONFIG',
);
