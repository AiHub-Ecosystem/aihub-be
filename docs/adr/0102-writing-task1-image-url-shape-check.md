# ADR-0102: Add a shape check for Writing Task 1 image URLs at AIHUB

- Status: Accepted
- Date: 2026-10-15
- Related issue: [#376](https://github.com/AiHub-Ecosystem/aihub-be/issues/376)
- Amends: [ADR-0084](0084-writing-task1-public-image-fetch-boundary.md)

## Context

ADR-0084 assigns image retrieval security to AI Writing because that service
resolves and fetches customer URLs. AIHUB can still reject unsafe URL shapes
before dispatch without resolving DNS, adding a hostname allowlist, or changing
which public customer hosts are supported.

## Decision

Before dispatching Task 1 grading, AIHUB accepts only HTTPS URLs of at most
2,000 characters, without embedded userinfo or a port other than the HTTPS
default. If the host is an IP literal, it must be a public IPv4 or IPv6 address;
the policy also rejects special-use and reserved literal ranges. DNS hostnames
are not resolved by AIHUB and remain unrestricted, including customer-owned
hosts.

These checks return the existing `INVALID_REQUEST` response before an
AI-service dispatch attempt. Normal invalid-request metering still applies.
AIHUB does not fetch the image. AI Writing remains responsible for resolving
all addresses, refusing non-public or special-use results, pinning a checked
address, refusing redirects, and enforcing the existing size and deadline
limits from ADR-0084.

## Consequences

- Customer-owned public HTTPS hosts continue to work without an allowlist.
- Literal private, loopback, link-local, multicast, unspecified, and reserved
  targets fail at the AIHUB boundary.
- DNS rebinding and hostname-to-private-address risks remain the provider's
  responsibility; this ADR does not replace the Layer B fetch controls.
