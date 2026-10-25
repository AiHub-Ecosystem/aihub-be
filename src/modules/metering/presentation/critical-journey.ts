import type { OperationId } from '@/catalog/operation-id';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';

export type CriticalJourney =
  | 'graded_request'
  | 'authentication'
  | 'organization_management'
  | 'api_key_management';

const PUBLIC_ROUTE_ID_BY_SIGNATURE = new Map(
  Object.entries(PUBLIC_ROUTES).map(([id, route]) => [
    `${route.method} ${route.path}`,
    id,
  ]),
);

export function criticalJourneyForRequest(
  method: string,
  route: string,
  operation: OperationId | undefined,
): CriticalJourney | undefined {
  if (operation !== undefined) return 'graded_request';

  const routeId = PUBLIC_ROUTE_ID_BY_SIGNATURE.get(`${method} ${route}`);
  if (routeId?.startsWith('auth.')) return 'authentication';
  if (routeId?.startsWith('organizations.apiKeys.')) {
    return 'api_key_management';
  }
  if (routeId?.startsWith('organizations.')) return 'organization_management';

  return undefined;
}
