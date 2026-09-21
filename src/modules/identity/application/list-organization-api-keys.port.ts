import type {
  ListOrganizationApiKeysCommand,
  ListedOrganizationApiKey,
} from './list-organization-api-keys';

export interface ListOrganizationApiKeysPort {
  list(
    input: ListOrganizationApiKeysCommand,
  ): Promise<readonly ListedOrganizationApiKey[]>;
}

export const LIST_ORGANIZATION_API_KEYS = Symbol('LIST_ORGANIZATION_API_KEYS');
