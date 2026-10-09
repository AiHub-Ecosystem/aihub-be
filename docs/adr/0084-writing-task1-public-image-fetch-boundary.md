# ADR-0084: Bound AI Writing Task 1 image fetches to public HTTPS targets

- Status: Accepted
- Date: 2026-10-09
- Related issue: [#376](https://github.com/AiHub-Ecosystem/aihub-be/issues/376)

Writing Task 1 keeps accepting customer-supplied image URLs from any public host to preserve the current integration contract; images must be publicly readable without signatures or credentials. AIHUB's request schema rejects non-HTTPS URLs, and the AI Writing provider repeats that check before fetching. The provider rejects redirects, resolves all IPv4 and IPv6 answers, rejects the URL if any answer is non-public or special-use, and pins the checked address for the connection. Each fetch is limited to 10 MiB and 10 seconds across DNS, connection, and body download.

This broadens the accepted Task 1 input hosts beyond the sample image's origin in ADR-0060; it does not move the AIHUB sample or change its public-read requirement.

The fetch guard belongs in AI Writing because it makes the outbound request and controls the network position, which may move between VPS hosts. The current provider host has no systemd egress isolation, and its host firewall allows outgoing traffic, so the provider must not rely on host placement to protect internal services. Provider tests will cover private, loopback, link-local, metadata, mixed DNS answers, and redirects to internal targets without probing Production.

This preserves customer-hosted public images while preventing the provider from reaching non-public destinations. A host allowlist or AIHUB-owned upload asset would change the public contract and is not part of this decision.
