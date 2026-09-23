import { invalidRequest } from '../../../common/errors/invalid-request';
import type { RequestContext } from '../../../common/request-context/request-context';
import { organizationName } from '../domain/organization-name';

import { forbidden } from './organization-membership.authorization';
import type { OrganizationRenamePort } from './organization-rename.port';

/**
 * One message for every refusal, following the audit read. A suspended-specific
 * or role-specific message would tell a caller holding no membership that the
 * Organization they guessed exists, or that it is suspended.
 */
const ORGANIZATION_RENAME_FORBIDDEN = 'Organization rename is forbidden';

export interface RenameOrganizationInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly name: string;
}

export interface RenamedOrganization {
  readonly organizationId: string;
  readonly name: string;
  readonly status: 'active';
}

/**
 * Renames an Organization for its active owner (ADR-0043). The name is the only
 * owner-mutable attribute; commercial terms never reach this path.
 */
export class RenameOrganization {
  constructor(private readonly organizations: OrganizationRenamePort) {}

  async rename(input: RenameOrganizationInput): Promise<RenamedOrganization> {
    const name = organizationName(input.name);
    if (name === undefined) {
      throw invalidRequest();
    }

    const result = await this.organizations.renameOrganization({
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      name,
    });
    if (result.kind === 'forbidden') {
      throw forbidden(ORGANIZATION_RENAME_FORBIDDEN);
    }

    // Only an active Organization can be renamed, so its status is known.
    return {
      organizationId: result.organizationId,
      name: result.name,
      status: 'active',
    };
  }
}
