/**
 * The request target's path, with any query string removed.
 *
 * Every HTTP hook that decides something from the URL has to ignore the query
 * string: the raw URL carries caller-supplied values, and a hook keyed on
 * `url` alone would read them. One implementation keeps that decision in one
 * place instead of in each hook that happens to need it.
 */
export function pathnameOf(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/** The one route that is infrastructure rather than API. */
const HEALTH_PROBE_PATH = '/health';

/**
 * Whether this request is a probe. Request tracing and the Request Completion
 * Event both skip probes: they run every few seconds and would bury real
 * requests. One predicate, so the two never drift into disagreeing about which
 * traffic is operational.
 */
export function isHealthProbe(url: string): boolean {
  return pathnameOf(url) === HEALTH_PROBE_PATH;
}
