import type { OrganizationApiKeyView } from './organization-api-key-view';
import type { RevokeOrganizationApiKeyCommand } from './revoke-organization-api-key';

export interface RevokeOrganizationApiKeyPort {
  revoke(
    input: RevokeOrganizationApiKeyCommand,
  ): Promise<OrganizationApiKeyView>;
}

export const REVOKE_ORGANIZATION_API_KEY = Symbol(
  'REVOKE_ORGANIZATION_API_KEY',
);
