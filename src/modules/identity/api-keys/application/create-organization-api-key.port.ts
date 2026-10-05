import type {
  CreateOrganizationApiKeyInput,
  CreatedOrganizationApiKey,
} from './create-organization-api-key';

export interface CreateOrganizationApiKeyPort {
  create(
    input: CreateOrganizationApiKeyInput,
  ): Promise<CreatedOrganizationApiKey>;
}

export const CREATE_ORGANIZATION_API_KEY = Symbol(
  'CREATE_ORGANIZATION_API_KEY',
);
