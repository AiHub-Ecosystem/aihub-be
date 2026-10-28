import type { FastifyInstance } from 'fastify';

import { publicApiMajorOf } from '@/catalog/public-api-major';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import { getMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import type { PublicApiMajorUsageSample } from '@/modules/metering/application/public-api-major-usage';
import { requestOutcome } from '@/modules/metering/application/request-outcome';

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
    const major = publicApiMajorOf(routeTemplate(request));
    if (major !== undefined) {
      const organizationId =
        getMeteringEvidence(request)?.organizationId ??
        request.aihubAuth?.organizationId;
      record({
        major,
        ...(organizationId === undefined ? {} : { organizationId }),
        failed:
          requestOutcome(reply.statusCode, request.aihubFailureCode) !==
          'success',
        at: new Date(),
      });
    }
    done();
  });
}
