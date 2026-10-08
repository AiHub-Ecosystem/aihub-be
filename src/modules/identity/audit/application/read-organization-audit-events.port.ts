import type {
  OrganizationAuditEventPage,
  ReadOrganizationAuditEventsCommand,
} from './read-organization-audit-events';

export interface ReadOrganizationAuditEventsPort {
  read(
    input: ReadOrganizationAuditEventsCommand,
  ): Promise<OrganizationAuditEventPage>;
}

export const READ_ORGANIZATION_AUDIT_EVENTS = Symbol(
  'READ_ORGANIZATION_AUDIT_EVENTS',
);
