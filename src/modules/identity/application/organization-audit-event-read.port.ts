import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  OrganizationAuditAction,
  OrganizationAuditOutcome,
  OrganizationAuditTargetType,
} from '../domain/organization-audit-event';

/** The position a cursor resolves to: the last event of the previous page. */
export interface OrganizationAuditEventPosition {
  readonly occurredAt: Date;
  readonly id: string;
}

/**
 * The durable filter. Every field is optional because every query parameter
 * is, and a half-open `[from, to)` window is two independent bounds rather
 * than one object, so asking only "since Tuesday" needs no invented end.
 */
export interface OrganizationAuditEventFilter {
  readonly actions?: readonly OrganizationAuditAction[];
  readonly outcome?: OrganizationAuditOutcome;
  readonly from?: Date;
  readonly to?: Date;
}

export interface ListOrganizationAuditEventsInput {
  readonly context: RequestContext;
  readonly organizationId: string;
  readonly filter: OrganizationAuditEventFilter;
  readonly after?: OrganizationAuditEventPosition;
  /**
   * The repository reads one more than this so the caller can tell a full page
   * from the end of the trail without a second query.
   */
  readonly limit: number;
}

/**
 * One recorded act as this read publishes it. The actor is resolved to their
 * immutable Username here rather than by the caller, and the durable
 * `targetId` never leaves the repository: for a membership it is a User
 * Account ID.
 */
export interface OrganizationAuditEventRecord {
  readonly id: string;
  readonly action: OrganizationAuditAction;
  readonly outcome: OrganizationAuditOutcome;
  readonly targetType: OrganizationAuditTargetType;
  /** `null` once Audit redaction has removed it. */
  readonly targetLabel: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface OrganizationAuditEventReadPort {
  listAuditEvents(
    input: ListOrganizationAuditEventsInput,
  ): Promise<readonly OrganizationAuditEventRecord[]>;
}

export const ORGANIZATION_AUDIT_EVENT_READ = Symbol(
  'ORGANIZATION_AUDIT_EVENT_READ',
);
