import type {
  RenameOrganizationInput,
  RenamedOrganization,
} from './rename-organization';

export interface RenameOrganizationPort {
  rename(input: RenameOrganizationInput): Promise<RenamedOrganization>;
}

export const RENAME_ORGANIZATION = Symbol('RENAME_ORGANIZATION');
