# ADR-0199: Bound Avatar uploads at the storage ingress

- Status: Proposed, pending verification with the shared storage operator
- Date: 2026-11-26
- Related issue: [#2008](https://github.com/AiHub-Ecosystem/aihub-be/issues/2008)
- Related: [ADR-0196](0196-one-upload-session-core-serves-avatar-speaking-and-writing.md)
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

## Recorded evidence

A read-only inspection on 2026-11-26 established the enforcement point and
coverage. `/etc/nginx/nginx.conf` includes `/etc/nginx/sites-enabled/*`, and
`/etc/nginx/sites-enabled/s3.wispace.app` is a regular operator-managed file
whose HTTPS `server_name s3.wispace.app` proxies `location /` to
`http://127.0.0.1:8333` with `client_max_body_size 500M`, `Host $host`, the
forwarding headers, and 300-second connect and read timeouts. No request
buffering, CORS, rewrite, or other request transformation is configured there.
The only nginx file that mentions the S3 upstream is this one vhost, Docker
publishes SeaweedFS S3 on `127.0.0.1` only, and the backend signer uses
path-style URLs, so both configured staging buckets reach the ingress on the
same supported path. `nginx -t` passed with nginx 1.28.3 (Ubuntu). The live
SeaweedFS is 4.41 (`de34a1a87`, image `chrislusf/seaweedfs:4.41`, digest
`sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d`).

A read-only `OPTIONS` through that vhost returned `200` with a matching
`Access-Control-Allow-Origin` and `Vary: Origin` for both default staging
buckets and each of `https://aihubproduction.com`,
`https://www.aihubproduction.com`, and `https://sandbox.aihubproduction.com`.
Those are the origins the ingress-generated `413` reuses; it introduces no
broader grant and does not change proxied responses. The last of the three is
the Sandbox API vhost, not a browser app, so this is an HTTP origin check and
the browser evidence still comes from the deployment's configured Customer Web
origin. A separate filer location is outside the supported path-style presigned
`PUT` flow and was not assessed.

`ops/nginx/s3-wispace-avatar-upload-limit.conf` is the reviewed, operator-
installed fragment for that server, with install, verification, and rollback in
`docs/operations/deploy-vps.md`. `test/ops/avatar-upload-limit.spec.sh` runs the
fragment itself against a local nginx 1.28.3 and a stub S3 upstream, under a
parent that inherits request buffering off and upstream error interception on.
It shows acceptance at exactly 2,097,152 bytes, rejection of one byte more
including a chunked body, that no rejected or incomplete body reaches the
upstream, that the exact signed request target and `Host` arrive unchanged,
distinct handling for the ACME, filer, and health routes, a readable `413` from
the three origins only, and an upstream `413` left unrewritten. These are local
checks against the artifact, not live evidence.

The host change is not authorized or applied. The observed coverage, the local
artifact checks, and the operator instructions are recorded here; the
provider-backed Sandbox end-to-end verification and the supported-origin checks
against the deployed ingress are still pending, as is the Production rollout.
This decision stays Proposed until that live evidence is recorded.

If the ingress cannot cover every supported upload path or the operator cannot
take on the scoped change, keep #2008 open and revisit the enforcement point.
Changing the upload origin, method, or routing through AIHUB requires a new
decision and review of Customer Web compatibility.
