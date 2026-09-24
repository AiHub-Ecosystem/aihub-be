import type {
  ReadOrganizationIdentityConfigCommand,
  ReadOrganizationIdentityConfigResult,
} from './read-organization-identity-config';

export interface ReadOrganizationIdentityConfigPort {
  read(
    input: ReadOrganizationIdentityConfigCommand,
  ): Promise<ReadOrganizationIdentityConfigResult>;
}

export const READ_ORGANIZATION_IDENTITY_CONFIG = Symbol(
  'READ_ORGANIZATION_IDENTITY_CONFIG',
);
