import type {
  RotateOrganizationApiKeyInput,
  RotatedOrganizationApiKey,
} from './rotate-organization-api-key';

export interface RotateOrganizationApiKeyPort {
  rotate(
    input: RotateOrganizationApiKeyInput,
  ): Promise<RotatedOrganizationApiKey>;
}

export const ROTATE_ORGANIZATION_API_KEY = Symbol(
  'ROTATE_ORGANIZATION_API_KEY',
);
