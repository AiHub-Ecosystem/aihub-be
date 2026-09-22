import type {
  CreateOrganizationInput,
  CreatedOrganization,
} from './create-organization';

export interface CreateOrganizationPort {
  create(input: CreateOrganizationInput): Promise<CreatedOrganization>;
}

export const CREATE_ORGANIZATION = Symbol('CREATE_ORGANIZATION');
