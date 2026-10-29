import type { FastifyInstance } from 'fastify';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import { publicApiMajorOf } from '@/catalog/public-api-major';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import { getMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import type {
  PublicApiCallerKind,
  PublicApiMajorUsageSample,
} from '@/modules/metering/application/public-api-major-usage';
import { requestOutcome } from '@/modules/metering/application/request-outcome';

/**
 * How each route authenticates its caller, keyed by method and route template.
 * Every AI dispatch operation takes an Organization API key.
 */
const CALLER_KINDS = new Map<string, PublicApiCallerKind>([
  ...(Object.values(PUBLIC_ROUTES) as PublicRouteDef[]).map(
    (route) => [`${route.method} ${route.path}`, route.callerAuth] as const,
  ),
  ...(Object.values(OPERATION_CATALOG) as OperationDef[]).map(
    (operation) =>
      [`${operation.method} ${operation.path}`, 'api-key'] as const,
  ),
]);

function callerKindOf(method: string, template: string): PublicApiCallerKind {
  const routeMethod = method === 'HEAD' ? 'GET' : method;
  return CALLER_KINDS.get(`${routeMethod} ${template}`) ?? 'undeclared';
}

/**
 * One sample per response to a matched `/vN/...` route (ADR-0127), taken from
 * `onResponse` like the completion log so every reply is seen, refusals
 * included. The major comes from the route template, never the raw URL, so a
 * probe, `/docs`, an unmatched path, or a caller-chosen value cannot create a
 * sample. Only the Organization an authenticated request already carries is
 * recorded.
 */
export function registerPublicApiMajorUsage(
  instance: FastifyInstance,
  record: (sample: PublicApiMajorUsageSample) => void,
): void {
  instance.addHook('onResponse', (request, reply, done) => {
    const template = routeTemplate(request);
    const major = publicApiMajorOf(template);
    if (major !== undefined) {
      const organizationId =
        getMeteringEvidence(request)?.organizationId ??
        request.aihubAuth?.organizationId;
      record({
        major,
        ...(organizationId === undefined ? {} : { organizationId }),
        callerKind: callerKindOf(request.method, template),
        failed:
          requestOutcome(reply.statusCode, request.aihubFailureCode) !==
          'success',
        at: new Date(),
      });
    }
    done();
  });
}
