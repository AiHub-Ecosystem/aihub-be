import type { RequestContext } from '@/common/request-context/request-context';

import { admitOrganizationRead } from '@/modules/identity/membership/application/organization-admission';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import {
  type ListOrganizationAuditEventsInput,
  type OrganizationAuditEventFilter,
  type OrganizationAuditEventPosition,
  type OrganizationAuditEventReadPort,
  type OrganizationAuditEventRecord,
} from './organization-audit-event-read.port';

export interface ReadOrganizationAuditEventsCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly filter: OrganizationAuditEventFilter;
  readonly after?: OrganizationAuditEventPosition;
  readonly limit: number;
}

export interface OrganizationAuditEventPage {
  readonly events: readonly OrganizationAuditEventRecord[];
  /** The last event of this page when another page follows, else undefined. */
  readonly next?: OrganizationAuditEventPosition;
}

/**
 * Reads an Organization's audit trail for an authorized owner or admin. The
 * repository owns the durable filter, the newest-first order, and the keyset
 * predicate; this use case owns the membership policy and the page boundary.
 *
 * A suspended Organization stays readable, deliberately unlike the sibling
 * open-invitation and API-key listings. Those are management surfaces, and
 * suspending an Organization should close them. This is evidence: refusing it
 * would make suspension erase the record exactly when the record matters, and
 * an owner investigating a suspension has nowhere else to look. ADR-0040
 * records the divergence, so there is no `organizationStatus` branch below to
 * mistake for an omission.
 */
export class ReadOrganizationAuditEvents {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly auditEvents: OrganizationAuditEventReadPort,
  ) {}

  async read(
    input: ReadOrganizationAuditEventsCommand,
  ): Promise<OrganizationAuditEventPage> {
    const admission = await admitOrganizationRead(this.membership, {
      surface: 'audit_read',
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const query: ListOrganizationAuditEventsInput = {
      context: input.context,
      organizationId: input.organizationId,
      filter: input.filter,
      ...(input.after === undefined ? {} : { after: input.after }),
      // One beyond the page tells us another page exists without a count over
      // a table that only grows.
      limit: input.limit + 1,
    };

    const rows = await this.auditEvents.listAuditEvents(query);
    if (rows.length <= input.limit) {
      return { events: rows };
    }

    const events = rows.slice(0, input.limit);
    const last = events[events.length - 1];
    if (last === undefined) {
      return { events };
    }

    return {
      events,
      next: { occurredAt: last.occurredAt, id: last.id },
    };
  }
}
