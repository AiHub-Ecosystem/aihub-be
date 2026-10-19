# ADR-0111: Revoke reported public Writing charts

- Status: Accepted
- Date: 2026-10-19
- Related issue: [#816](https://github.com/AiHub-Ecosystem/aihub-be/issues/816)
- Amends: [ADR-0100](0100-writing-task1-chart-image-uploads.md), specifically its abuse-report response target and operator response
- Follows: [ADR-0101](0101-writing-charts-use-shared-seaweedfs-host.md) for the public host and environment buckets

## Context

Published Writing charts are publicly readable until their 24-hour expiry.
ADR-0100 requires an AIHUB-controlled abuse-report contact and a one-business-
day response target, but the exact contact is a rollout value. The expiry
sweep runs every 15 minutes and does not provide an operator action for a
reported chart.

On 2026-10-19, read-only probes confirmed DNS and TLS for `s3.wispace.app` and
returned 404 for fabricated nonexistent keys in both public chart buckets. The
upload adapter sets `Cache-Control: public, max-age=300, must-revalidate`, but
the response headers and delete propagation of an existing chart were not
measured. No cache/CDN purge configuration or API was found in the repository.
These observations do not establish a stale-serving bound.

## Decision

Provide revocation through an environment-specific operator CLI. Execution is
authorized by access to that deployment's operator host and credentials. The
required `--actor` is an active AIHUB account used for attribution; it does not
grant permission. Do not add a public or customer-facing delete endpoint.

The operator supplies the reported public URL. The command accepts only HTTPS
URLs on `s3.wispace.app` under the Production `aihub-writing-charts` or Sandbox
`aihub-sandbox-writing-charts` public bucket and an exact published chart key.
URLs outside those buckets are escalated to the responsible party. The command
does not access or retain image bytes or raw report content.

Delete the exact object idempotently. A URL remains sufficient after the
scheduled expiry sweep has removed its database row; do not retain a chart-row
tombstone solely for repeated revocation. Record an `already absent` result
when storage no longer has the object.

Write an internal append-only audit record in the database for the selected
environment before touching storage. If that request event cannot be persisted,
do not delete the object. After the origin and edge checks, append a completion
event with their outcomes. If completion logging fails, the durable request
event remains as evidence that the operation began, while its result is
unconfirmed. Record the chart asset ID, operator account, timestamp, and phase;
do not store the public URL, report, or image bytes. Keep events for 24 months
and remove only older events through the managed per-environment
retention-prune job.

Report origin deletion separately from public-edge verification. Probe the
public GET path with a bounded one-byte Range request and cancel the response
body after headers arrive. If a public probe still receives the chart after
origin deletion, record propagation as pending, recheck it, and escalate if it
remains public beyond the measured bound. Before #816 closes, use one
synthetic, non-sensitive object in each public bucket to measure the actual GET
response headers and behavior after deletion. Document only an observed
stale-serving bound; the configured `max-age` value and a nonexistent-key 404
are not evidence of that bound.

The one-business-day target means triage and a response to the reporter. It
does not guarantee completed revocation within one business day or deletion of
copies outside AIHUB's control. The real AIHUB-controlled report contact must
be selected by the operations/support owner and published before public chart
rollout.

## Consequences

- #816 must implement the CLI, per-environment append-only audit, 24-month
  retention prune, and public-edge result reporting.
- The request event is persisted before object deletion so a database failure
  cannot leave a successful delete with no durable evidence. A missing
  completion event means the result needs operational follow-up.
- The actual public-cache behavior remains unverified until the two controlled
  bucket tests complete; the rollout gate and issue must remain open until then.
- The runbook distinguishes origin deletion from public-edge unavailability
  and from copies outside AIHUB's control.
- The audit record contains operator identity and asset metadata. The privacy
  inventory records it as internal control-plane data with 24-month retention.
