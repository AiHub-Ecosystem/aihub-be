# ADR 0181 — Scalar renderer 1.83.0

- Status: Accepted
- Date: 2026-11-23

## Context

ADR 0078 pinned the browser renderer for `/docs` to Scalar 1.72.1 with an SRI
hash and a matching `script-src` entry in the page CSP. The 1.72.1 renderer
renders the Authentication heading underneath its own auth-type selector at
the viewport width used by the AIHUB docs page.

## Decision

Serve the `/docs` renderer from `https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.83.0`
with SRI `sha384-Z2Wz4L/5mCSEGTCpHPw3JIN6+eRxpIwq2sE2QfGtP+hmmwcgJKNVK9zBbfnbjlKN`.
The CSP `script-src` allows only that hash. No inline scripts are added.

## Consequences

- The docs page keeps a pinned, integrity-checked renderer.
- The bundle grows from 4,473,612 to 4,654,135 bytes; the docs page downloads
  roughly 180 KB more JavaScript.
- The renderer is still fetched at runtime from jsDelivr; ADR 0078's CDN
  dependency remains unchanged.
- Any future renderer bump must update the URL, the SRI hash, the CSP hash,
  the controller spec, and the e2e mock together.
