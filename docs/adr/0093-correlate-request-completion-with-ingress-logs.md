# ADR-0093: Correlate request completion with ingress logs

- Status: Accepted
- Date: 2026-10-12
- Related issues: [#450](https://github.com/AiHub-Ecosystem/aihub-be/issues/450), [#287](https://github.com/AiHub-Ecosystem/aihub-be/issues/287), [#363](https://github.com/AiHub-Ecosystem/aihub-be/issues/363), [#436](https://github.com/AiHub-Ecosystem/aihub-be/issues/436), [#139](https://github.com/AiHub-Ecosystem/aihub-be/issues/139)
- Related ADRs: [ADR-0079](0079-managed-nginx-configuration-on-shared-vps.md), [ADR-0086](0086-trust-single-nginx-hop-for-caller-ips.md)
- Amends: [ADR-0079](0079-managed-nginx-configuration-on-shared-vps.md) — pins logrotate policy content and defines active-log rollback behavior

## Context

The `request_completed` event has a fixed field allowlist and an AIHUB-generated
request ID, but it does not record the caller address or authenticated API key
ID. The request ID is also absent from the response headers and nginx access
logs. An operator therefore cannot reliably connect an application event to
the network caller or its proxy record. For unmatched routes, the application
records the fixed route label `unmatched`, not the request path.

ADR-0086 is accepted and configures Fastify to trust the immediate nginx host
gateway, so `request.ip` resolves the address nginx observed for ordinary
proxied requests. A Web Session request reaches AIHUB from the Customer Web
BFF; its observed address identifies that BFF. Issue #436 has not established
validated end-user IP forwarding.

Both application and nginx access logs can contain personal data. At the time
this ADR was accepted, #287 had not recorded their categories and retention,
and #363 had not chosen the application container log bounds. The host's
default nginx access log is shared with other sites, so AIHUB-specific logging
must remain isolated.

## Decision

Use the AIHUB-generated Fastify request ID as the correlation value. Return it
in the `X-Request-Id` response header on every application response, including
errors and unmatched 404s, and record that same value in `request_completed`
and the AIHUB nginx access log. Do not accept a caller-supplied request ID as
the correlation value.

Add `client_ip` and an always-present `client_ip_source` to the existing
completion-event allowlist. Derive `client_ip` from Fastify's `request.ip`
under ADR-0086; do not parse forwarding headers separately. Use these source
values:

- `nginx` when the address is attributed through the trusted nginx hop;
- `direct_peer` when the request reaches the app without that trusted proxy;
- `customer_web_bff` on a Web Session request only after its client-secret
  guard succeeds, with `client_ip` remaining the observed BFF address;
- `end_user_forwarded` only after #436 establishes and validates that
  forwarding contract. It is not part of the initial #450 implementation.

Record `api_key_id` only after API-key authentication succeeds, using the
authenticated request context. Omit it for other requests and failed key
authentication. Never record an API key, request headers, raw request bodies,
query values, raw downstream responses, or a caller-supplied address.

Keep the application event's existing route-template behavior: an unmatched
request remains `route: "unmatched"`; do not add its raw URL or path to the
application event. For path investigation, correlate by request ID with the
nginx record.

Give AIHUB its own nginx `log_format`, access-log destination, and rotation
configuration. Extend the managed nginx helper's fixed config allowlist to
install these AIHUB-owned files, and create or secure the active log as
`root:adm` mode `0640` without truncating existing records. The access record
contains only the observed IP, request ID, method, path without query, and
status. It omits the query string, user agent, referrer, and other fields. Do
not change the shared default nginx access log or another site's configuration.
The root helper accepts the staged logrotate file only when it matches the
SHA-256 pinned in the operator-installed helper, because its `postrotate`
command runs as root. Updating the policy requires an operator-reviewed helper
update. On a failed config update, rollback restores the managed config files;
it deliberately retains the active data file and its restrictive permissions
so it neither deletes records nor re-exposes client addresses.

Use size-bounded rolling retention for both live log surfaces, not a promised
number of calendar days. Apply the application container limits established by
#363 and configure a separate nginx rotation with a 10 MiB threshold and four
rotated files. The active nginx file may exceed the threshold between host
logrotate runs. Before #450 is complete or closed, #287 must record the
personal-data categories, stores, retention trigger and deletion behavior, and
the application and nginx bounds must be documented with their chosen values.
Implementation may proceed in parallel with #287 and #363.

## Proposed acceptance criteria for #450

- [ ] Every application response, including handled errors and unmatched
      404s, returns its AIHUB-generated ID in `X-Request-Id`; the matching
      `request_completed` event and AIHUB nginx access record carry the same ID.
- [ ] `request_completed` adds `client_ip` from `request.ip` and always emits
      `client_ip_source` with the source values defined above. It emits
      `api_key_id` only after successful API-key authentication.
- [ ] Web Session requests are labeled `customer_web_bff` only after the
      client-secret guard passes. Guard failures retain `nginx` or
      `direct_peer`; `end_user_forwarded` is deferred until #436 validates the
      forwarding contract.
- [ ] The strict completion-event allowlist test rejects every unapproved
      field. The application event does not add a raw URL or query value.
- [ ] The managed nginx helper installs AIHUB-only logging and rotation
      configuration and restricts the active log to `root:adm` mode `0640`.
      It rejects staged rotation content that does not match its pinned digest.
      AIHUB access records contain only IP, request ID, method, path without
      query, and status; the shared host log and other sites remain unchanged.
- [ ] #287 records the personal data in application logs (`client_ip` and
      `api_key_id`) and nginx logs (IP and path), their stores, retention
      triggers, and deletion behavior, including deployment snapshots in
      `deploy-logs/`. #363 documents the application
      container log limits, and the nginx rotation configuration documents its
      10 MiB threshold and four rotated files.
- [ ] After deployment, production evidence shows requests from distinct
      known source addresses with the expected `client_ip` and source, and
      matching request IDs across the response, application event, and nginx
      access record. Record the deployed `main` commit and observed result on
      #450 before closing it.
- [ ] `pnpm verify` passes.

## Consequences

The application and proxy logs can be joined without timestamp-based matching,
and the application event can identify the network address it observed. The
source field prevents a BFF address from being mistaken for an end-user
address. API-key identifiers make key-specific incident investigation
possible without exposing key material.

The IP and API-key identifier expand the personal data in application logs,
and nginx will retain the path without its query string. The deployment also
saves up to 20 MB of each replaced app container's logs under `deploy-logs/`
for 30 days; that separate copy must be included in #287 and reconciled with
the agreed size-bounded policy before #450 is closed. Size-bounded retention
does not promise a fixed number of days; the observed time window depends on
log volume.

## Confirmation

The source-IP behavior follows accepted ADR-0086. The response header,
completion-event fields, BFF source marker, AIHUB-only nginx access log, and
size-based rotation are implemented. Focused HTTP tests cover generated IDs,
trusted-proxy IP resolution, API-key IDs, and the BFF guard. Production
deployment and evidence were pending when this ADR was accepted. The managed
helper installs only the two AIHUB vhosts, the AIHUB log-format include, and the
AIHUB logrotate policy, and ensures the active access log is `root:adm` mode
`0640` without truncating records; it leaves the shared host configuration
outside its allowlist.

Production confirmation on 2026-10-13: `ops/status.sh` reported Production and
Sandbox on revision `28510a2`, healthy with readiness `200`, zero restarts, and
zero error-like log lines. Two probes from distinct source addresses returned
AIHUB request IDs that matched both `request_completed` and the AIHUB nginx
access records. In both events, `client_ip` matched nginx's observed address;
one probe supplied a forged `X-Forwarded-For` value, which did not change the
resolved address. Three recent Web Session events were labeled
`customer_web_bff`. The observed request IDs and results are recorded on
[#450](https://github.com/AiHub-Ecosystem/aihub-be/issues/450). The inventory
in [#287](https://github.com/AiHub-Ecosystem/aihub-be/issues/287) now reflects
the production container-log settings; application and nginx retention bounds
are recorded there and in #363. CI `pnpm verify` passed for the deployed main
revision.

The production evidence gate for #450 is complete. #139 is closed and its
production source-IP behavior is now observed. #436 remains open; until it
validates end-user forwarding, Web Session events correctly identify the
observed BFF address.

API-key logging confirmation, 2026-10-13: one request to the production
Writing Task 1 route authenticated with an API key and produced a matching
`request_completed` event with `api_key_id` present. It returned
`401 USER_IDENTITY_REQUIRED` because the probe intentionally omitted
`X-User-Identity`; it stopped before dispatching a grading request. The event
is identified by request ID `req_01M4SGBEX5134K3M5PBEM4VQ7P`.
