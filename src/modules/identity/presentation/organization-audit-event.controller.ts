import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { ListOrganizationAuditEventsResponse } from '@/contracts/organization/audit-event';
import { UserAccessJwtGuard } from '@/modules/auth/presentation/user-access-jwt.guard';
import {
  READ_ORGANIZATION_AUDIT_EVENTS,
  type ReadOrganizationAuditEventsPort,
} from '@/modules/identity/application/read-organization-audit-events.port';

import { encodeAuditCursor } from './audit-cursor';
import { parseOrganizationAuditQuery } from './audit-event-query';
import { bearerRequestContext } from './bearer-request-context';

@Controller()
@UseGuards(UserAccessJwtGuard)
export class OrganizationAuditEventController {
  constructor(
    @Inject(READ_ORGANIZATION_AUDIT_EVENTS)
    private readonly auditEvents: ReadOrganizationAuditEventsPort,
  ) {}

  @Get(PUBLIC_ROUTES['organizations.auditEvents.list'].path)
  @HttpCode(PUBLIC_ROUTES['organizations.auditEvents.list'].successStatus)
  async list(
    @Req() request: FastifyRequest,
    @Param('organizationId') organizationId: string,
  ): Promise<ListOrganizationAuditEventsResponse> {
    const { context, requestId, userId } = bearerRequestContext(
      request,
      organizationId,
    );

    const { filter, after, limit } = parseOrganizationAuditQuery(request.query);

    const page = await this.auditEvents.read({
      context,
      userId,
      organizationId,
      filter,
      ...(after === undefined ? {} : { after }),
      limit,
    });

    return {
      data: {
        events: page.events.map((event) => ({
          event_id: event.id,
          action: event.action,
          outcome: event.outcome,
          target_type: event.targetType,
          target_label: event.targetLabel,
          detail: { ...event.detail },
          actor_username: event.actorUsername,
          // Named apart from `meta.request_id`: one is the act being read, the
          // other is the read itself, and they sit adjacent in one response.
          originating_request_id: event.requestId,
          occurred_at: event.occurredAt.toISOString(),
        })),
        next_cursor:
          page.next === undefined ? null : encodeAuditCursor(page.next, filter),
      },
      meta: { request_id: requestId },
    };
  }
}
