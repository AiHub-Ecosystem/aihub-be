import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { toOpenApiPath } from '@/openapi/openapi-path';
import { isRecord } from './postman-collection-utils';
import { BFF_CLIENT_SECRET_HEADER } from './postman-scenarios';

const ORGANIZATION_ROSTER_PATH =
  PUBLIC_ROUTES['organizations.me.members.list'].path;

const REFRESH_COOKIE_NAME = '__Host-aihub_refresh';

function isRefreshCookieAuth(auth: unknown): boolean {
  if (!isRecord(auth)) {
    return false;
  }

  const apiKey = auth.apikey;
  if (!Array.isArray(apiKey)) {
    return false;
  }

  const key = apiKey.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.key === 'key' && typeof entry.value === 'string',
  );

  return key?.value === REFRESH_COOKIE_NAME;
}

/**
 * openapi-to-postmanv2 maps an OpenAPI apiKey cookie scheme to an apikey
 * header auth entry. Keep the handover artifact faithful to the cookie-only
 * boundary by using Postman's native cookie field instead.
 */
export function normalizeRefreshCookieAuth(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      normalizeRefreshCookieAuth(entry);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const record = value;
  const request = record.request;
  if (isRecord(request)) {
    const requestRecord = request;
    if (isRefreshCookieAuth(requestRecord.auth)) {
      requestRecord.cookie = [
        {
          key: REFRESH_COOKIE_NAME,
          value: '{{refreshToken}}',
          path: '/',
          secure: true,
          httpOnly: true,
        },
      ];
      requestRecord.auth = undefined;

      const path = isRecord(requestRecord.url)
        ? requestRecord.url.path
        : undefined;
      const route = Array.isArray(path) ? path.join('/') : undefined;
      requestRecord.event = [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec:
              route === 'v1/auth/refresh'
                ? [
                    "pm.test('refresh rotates the access token and cookie', function () {",
                    '  pm.response.to.have.status(200);',
                    "  pm.expect(pm.response.headers.get('Set-Cookie')).to.include('__Host-aihub_refresh=');",
                    '});',
                  ]
                : [
                    "pm.test('logout revokes the session and clears the cookie', function () {",
                    '  pm.response.to.have.status(204);',
                    "  pm.expect(pm.response.headers.get('Set-Cookie')).to.include('__Host-aihub_refresh=');",
                    '  pm.expect(pm.response.text()).to.eql("");',
                    '});',
                  ],
          },
        },
      ];
    }
  }

  for (const child of Object.values(record)) {
    normalizeRefreshCookieAuth(child);
  }
}

export function addOrganizationRosterCheck(items: unknown[]): void {
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.request)) {
      continue;
    }

    const url = item.request.url;
    const path = isRecord(url) ? url.path : undefined;
    // The OpenAPI document renders `:param` as `{param}`, so compare against
    // the OpenAPI spelling. A roster path carrying a parameter would otherwise
    // stop matching here without anything failing.
    if (
      !Array.isArray(path) ||
      path.join('/') !== toOpenApiPath(ORGANIZATION_ROSTER_PATH).slice(1)
    ) {
      continue;
    }

    item.request.description =
      'Lists Organizations where the user has an active membership, including configured entitlement names. identity_configured reports saved active identity configuration only; it does not probe the JWKS source.';
    item.event = [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            "pm.test('each organization exposes entitlement and identity readiness', function () {",
            '  const organizations = pm.response.json().data.organizations;',
            "  pm.expect(organizations).to.be.an('array');",
            '  for (const organization of organizations) {',
            "    pm.expect(organization.entitlements).to.be.an('array');",
            "    pm.expect(organization.entitlements.every((value) => typeof value === 'string')).to.be.true;",
            "    pm.expect(organization.identity_configured).to.be.a('boolean');",
            "    pm.expect(organization).not.to.have.property('issuer');",
            "    pm.expect(organization).not.to.have.property('jwks_url');",
            "    pm.expect(organization).not.to.have.property('public_keys_jwks');",
            '  }',
            '});',
          ],
        },
      },
    ];
  }
}

/**
 * The converter publishes one scheme per request, so a route that needs the
 * API key and the BFF secret together gets the secret header added here. The
 * routes come from the catalog's `bff-api-key` caller auth, not from a path.
 */
const BFF_API_KEY_PATHS: ReadonlySet<string> = new Set(
  Object.values(PUBLIC_ROUTES)
    .filter((route) => route.callerAuth === 'bff-api-key')
    .map((route) => route.path),
);

export function addBffClientSecret(items: unknown[]): void {
  for (const item of items) {
    if (!isRecord(item)) continue;

    if (isRecord(item.request)) {
      const url = item.request.url;
      const path = isRecord(url) ? url.path : undefined;
      if (
        Array.isArray(path) &&
        path.every((part) => typeof part === 'string') &&
        BFF_API_KEY_PATHS.has(`/${path.join('/')}`)
      ) {
        const headers = Array.isArray(item.request.header)
          ? item.request.header
          : [];
        if (
          !headers.some(
            (header) =>
              isRecord(header) && header.key === BFF_CLIENT_SECRET_HEADER.key,
          )
        ) {
          headers.push(BFF_CLIENT_SECRET_HEADER);
        }
        item.request.header = headers;
      }
    }

    if (Array.isArray(item.item)) addBffClientSecret(item.item);
  }
}
