import type { FastifyRequest } from 'fastify';

function rawCookieHeader(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  return Array.isArray(header) ? header.join(';') : header;
}

export function hasDuplicateCookie(
  request: FastifyRequest,
  cookieName: string,
): boolean {
  // Fastify's parsed cookie map collapses duplicate names. This metadata-only
  // scan is therefore limited to counting the named cookie; credential value
  // extraction still comes exclusively from request.cookies.
  const header = rawCookieHeader(request);
  if (header === undefined) {
    return false;
  }

  let count = 0;
  for (const part of header.split(';')) {
    const name = part.trim().split('=', 1)[0]?.trim();
    if (name === cookieName) {
      count += 1;
    }
  }
  return count > 1;
}

function hasQueryValue(source: unknown): boolean {
  return (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    Object.keys(source).length > 0
  );
}

/**
 * The one statement of "this route reads its credential from one transport and
 * refuses the rest". An Authorization header, any query value, and any cookie
 * other than the route's own all mean the caller offered the credential
 * somewhere AIHUB does not read it from, so the route refuses instead of
 * choosing a source. A route that reads no cookie passes no `cookieName`, and
 * then every cookie counts. A second cookie of the route's own name is refused
 * because the parsed cookie map cannot say which one is real.
 *
 * The Bearer route (`UserAccessJwtGuard`) is the exception: it ignores
 * unrelated cookies, because a browser sends them on every call, and refuses
 * only the credential-named keys that mean a token in the wrong place.
 */
export function offersCredentialOutsideTransport(
  request: FastifyRequest,
  cookieName?: string,
): boolean {
  return (
    request.headers.authorization !== undefined ||
    hasQueryValue(request.query) ||
    Object.keys(request.cookies ?? {}).some((name) => name !== cookieName) ||
    (cookieName !== undefined && hasDuplicateCookie(request, cookieName))
  );
}
