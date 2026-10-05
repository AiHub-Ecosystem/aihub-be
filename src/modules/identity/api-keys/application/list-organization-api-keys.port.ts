import type { ListOrganizationApiKeysCommand } from './list-organization-api-keys';
import type { OrganizationApiKeyView } from './organization-api-key-view';

export interface ListOrganizationApiKeysPort {
  list(
    input: ListOrganizationApiKeysCommand,
  ): Promise<readonly OrganizationApiKeyView[]>;
}

export const LIST_ORGANIZATION_API_KEYS = Symbol('LIST_ORGANIZATION_API_KEYS');
