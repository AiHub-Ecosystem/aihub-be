import { internalError } from '@/common/errors/app-error';
/**
 * The Public API majors AIHUB has released (ADR-0127). This list is the one
 * source for which majors are served, their OpenAPI documents and `/docs`
 * selector, the major-level `Deprecation`/`Sunset` headers, and the `410` a
 * retired major answers with. `bun run generate:openapi` copies it to
 * `openapi/majors.json`, where the release gate checks its lifecycle rules.
 *
 * A major is retired by a release, never by the clock: that release sets
 * `status: 'retired'` and removes the major's routes and `openapi/vN.json`, so
 * the owner's sign-off (#1376) always comes first.
 */
export interface PublicApiMajorSunset {
  /** The major that replaces this one. */
  readonly successor: number;
  /** ISO 8601 instant; published as the RFC 9745 `Deprecation` date. */
  readonly deprecationAt: string;
  /** ISO 8601 instant; at least 12 months after the successor's release. */
  readonly sunsetAt: string;
}

interface PublicApiMajorBase {
  readonly major: number;
  /** SemVer of this major's contract, published as OpenAPI `info.version`. */
  readonly contractVersion: string;
  /** ISO 8601 date the major was first released. */
  readonly releasedAt: string;
}

export type PublicApiMajorDef =
  | (PublicApiMajorBase & {
      readonly status: 'supported';
      readonly sunset?: PublicApiMajorSunset;
    })
  | (PublicApiMajorBase & {
      readonly status: 'retired';
      readonly sunset: PublicApiMajorSunset;
    });

export const PUBLIC_API_MAJORS: readonly PublicApiMajorDef[] = [
  {
    major: 1,
    contractVersion: '1.7.0',
    status: 'supported',
    releasedAt: '2026-11-02',
    // ADR-0127: the successor release publishes the predecessor's sunset, at
    // least 12 months out. The date can only move later (#1376).
    sunset: {
      successor: 2,
      deprecationAt: '2026-11-01T00:00:00Z',
      sunsetAt: '2027-11-02T00:00:00Z',
    },
  },
  {
    major: 2,
    contractVersion: '2.5.0',
    status: 'supported',
    releasedAt: '2026-11-02',
  },
];

export function supportedPublicApiMajors(
  majors: readonly PublicApiMajorDef[] = PUBLIC_API_MAJORS,
): readonly PublicApiMajorDef[] {
  return majors.filter((major) => major.status === 'supported');
}

/** The newest supported major: what `/openapi.json` and `/docs` default to. */
export function latestPublicApiMajor(
  majors: readonly PublicApiMajorDef[] = PUBLIC_API_MAJORS,
): PublicApiMajorDef {
  const latest = supportedPublicApiMajors(majors).reduce<
    PublicApiMajorDef | undefined
  >(
    (newest, major) =>
      newest === undefined || major.major > newest.major ? major : newest,
    undefined,
  );
  if (latest === undefined) {
    throw internalError('No supported Public API major');
  }
  return latest;
}

export function findPublicApiMajor(
  major: number,
  majors: readonly PublicApiMajorDef[] = PUBLIC_API_MAJORS,
): PublicApiMajorDef | undefined {
  return majors.find((candidate) => candidate.major === major);
}
