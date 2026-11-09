import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { deprecationDateErrors } from './deprecation-dates';

const liveRouteIds = new Set([
  ...Object.keys(PUBLIC_ROUTES),
  ...Object.keys(OPERATION_CATALOG),
]);

let failed = false;
for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
  const sunset = (
    route as {
      sunset?: {
        deprecationAt: string;
        sunsetAt: string;
        successorRouteId?: string;
        rationale: string;
      };
    }
  ).sunset;
  if (sunset === undefined) continue;
  if (
    sunset.successorRouteId !== undefined &&
    !liveRouteIds.has(sunset.successorRouteId)
  ) {
    console.error(
      `${routeId}: successorRouteId ${sunset.successorRouteId} is not a live route.`,
    );
    failed = true;
  }
  for (const error of deprecationDateErrors(routeId, sunset)) {
    console.error(error);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('Deprecation descriptor check passed.');
