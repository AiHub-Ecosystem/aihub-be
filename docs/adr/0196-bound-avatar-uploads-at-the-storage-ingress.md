# ADR-0196: Bound Avatar uploads at the storage ingress

- Status: Proposed, pending verification with the shared storage operator
- Date: 2026-11-26
- Related issue: [#2008](https://github.com/AiHub-Ecosystem/aihub-be/issues/2008)
- Builds on: [ADR-0069](0069-avatar-is-published-not-signed.md) and
  [ADR-0194](0194-avatar-uploads-are-re-encoded-and-audited.md)

The Avatar upload grant bounds the declared size, and completion validates the
staged image before publication. The direct upload receiver needs its own bound
on the actual request body. The Sandbox results in ADR-0069 show why completion
alone cannot enforce that bound.

## Proposed decision

Enforce a 2 MiB (2,097,152 byte) request body ceiling at the existing storage
ingress for the Avatar staging buckets in Sandbox and Production. The ingress
may buffer up to the ceiling and forwards only complete bodies within it.
Rejection happens during receipt for oversized bodies, including chunked
uploads. The browser can read HTTP `413` from origins already allowed to upload.
An oversized request creates no staging object.

Retain the existing presigned PUT, storage origin, signed headers and private
staging. This keeps already-issued grants on the same path and preserves
compatibility with Customer Web, which validates the origin and grant shape.
Completion still validates and re-encodes the image before publication.
[#1974](https://github.com/AiHub-Ecosystem/aihub-be/issues/1974) tracks the
independent bound on the completion read.

## Evidence required

Confirm that the shared storage ingress covers every supported path for both
configured Avatar staging buckets and agree on ownership of the scoped change.
Record the SeaweedFS version and enforcement point. Provider-backed Sandbox
verification must show acceptance at the ceiling, rejection above it with
bounded request handling and no staged object, and a valid browser upload
through private staging and completion.

If the ingress cannot cover every supported upload path or the operator cannot
take on the scoped change, keep #2008 open and revisit the enforcement point.
Changing the upload origin, method, or routing through AIHUB requires a new
decision and review of Customer Web compatibility.
