const MAJOR_PATH = /^\/v([1-9][0-9]*)\/./u;

/**
 * The Public API major a matched route template belongs to (ADR-0127: the URI
 * path is the only selector). Anything outside `/vN/...` is not part of the
 * versioned contract, including probes, `/metrics`, `/docs`, and the unmatched
 * sentinel, so it has no major.
 */
export function publicApiMajorOf(routeTemplate: string): number | undefined {
  const match = MAJOR_PATH.exec(routeTemplate);
  const major = match?.[1] === undefined ? undefined : Number(match[1]);
  return major !== undefined && Number.isSafeInteger(major) ? major : undefined;
}
