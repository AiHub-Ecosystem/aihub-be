import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';

const liveRouteIds = new Set([
  ...Object.keys(PUBLIC_ROUTES),
  ...Object.keys(OPERATION_CATALOG),
]);

let failed = false;
for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
  const sunset = (
    route as {
      sunset?: {
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
  const sunsetDate = new Date(sunset.sunsetAt);
  if (Number.isNaN(sunsetDate.getTime())) {
    console.error(`${routeId}: sunsetAt is not a valid date.`);
    failed = true;
  } else if (sunsetDate.getTime() < Date.now()) {
    console.error(
      `${routeId}: sunsetAt is in the past without the route being marked removed.`,
    );
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('Deprecation descriptor check passed.');
