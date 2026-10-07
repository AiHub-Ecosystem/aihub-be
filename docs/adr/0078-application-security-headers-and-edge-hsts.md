# ADR-0078: Application security headers and edge HSTS

- Status: Accepted
- Date: 2026-10-07
- Related: [#112](https://github.com/AiHub-Ecosystem/aihub-be/issues/112), [#316](https://github.com/AiHub-Ecosystem/aihub-be/issues/316)

## Context

Issue #316 needs security headers on application responses and a browser policy
for `/docs`. Issue #112 owns the production nginx configuration, including
HSTS and `server_tokens off`. Putting `X-Content-Type-Options` in both layers
could produce duplicate headers, while nginx configuration changes cannot be
validated and reloaded by CD until its sudo boundary is fixed.

Scalar currently loads from jsDelivr on `/docs`. The page needs a restrictive
Content Security Policy without breaking Scalar or sending the docs URL as a
referrer to the CDN.

## Decision

- The shared Fastify response hook sets `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer` on every application response.
- `/docs` receives a Content Security Policy with `frame-ancestors 'none'`.
  Scalar remains on jsDelivr at version `1.72.1` with Subresource Integrity and
  cross-origin anonymous loading. `script-src` allows only the pinned bundle's
  SRI hash and no inline scripts;
  `style-src` may allow inline styles needed by Scalar; `connect-src` is
  restricted to `'self'` for the same-origin OpenAPI document; `font-src`
  allows Scalar's Inter fonts from `fonts.scalar.com`. Other sources are
  limited to those the rendered page demonstrably needs.
- HSTS remains edge-only in #112 with a `max-age` of at least six months.
  `server_tokens off` also remains edge-owned. The edge configuration should
  not add `X-Content-Type-Options`, avoiding a duplicate on proxied application
  responses.
- HSTS and `server_tokens off` are applied to the live API and Sandbox nginx
  blocks after validation and reload. CD can now validate and reload nginx
  without a password, but cannot sync the configuration because it has no
  permission to write nginx config files.
- Verify headers and docs markup with Fastify injection tests, then manually
  smoke-test that `/docs` renders in a browser. Do not add browser automation
  infrastructure just for this page.

## Consequences

- Application responses get `nosniff` and `no-referrer`; the API and Sandbox
  edge blocks add HSTS and suppress the nginx version.
- The CDN still receives a request for Scalar, but SRI rejects bytes that do
  not match the pinned asset and the browser omits the referring URL.
- CSP may allow inline styles for Scalar, while scripts remain pinned and
  integrity-checked.
- CD cannot keep the manual nginx change in sync until it can safely write the
  nginx configuration.
