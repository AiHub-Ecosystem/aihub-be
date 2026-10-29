import {
  PUBLIC_API_MAJORS,
  type PublicApiMajorDef,
  findPublicApiMajor,
} from '@/catalog/public-api-majors';
import { AppError } from '@/common/errors/app-error';

const MAJOR_PREFIX = /^\/v([1-9][0-9]*)(?:\/|$)/u;

export interface RetiredPublicApiMajor {
  readonly error: AppError;
  /** `Link` header value naming the successor major's documentation. */
  readonly link: string;
}

/**
 * The `410` a request under a retired Public API major gets (ADR-0127). The
 * release that retires a major removes its routes, so these requests reach
 * the not-found path before any guard runs; the URL decides, not a route.
 */
export function retiredPublicApiMajor(
  url: string,
  majors: readonly PublicApiMajorDef[] = PUBLIC_API_MAJORS,
): RetiredPublicApiMajor | undefined {
  const match = MAJOR_PREFIX.exec(url.split('?')[0] ?? url);
  const major =
    match?.[1] === undefined
      ? undefined
      : findPublicApiMajor(Number(match[1]), majors);
  if (major?.status !== 'retired') return undefined;

  const retired = `v${major.major}`;
  const successor = `v${major.sunset.successor}`;
  const successorDocs = `/docs?version=${successor}`;
  return {
    error: new AppError({
      code: 'API_VERSION_RETIRED',
      message: `API version ${retired} is retired; use ${successor}`,
      retryable: false,
      details: {
        retired_major: retired,
        successor_major: successor,
        successor_docs: successorDocs,
      },
    }),
    link: `<${successorDocs}>; rel="successor-version"; title="${successor}"`,
  };
}
