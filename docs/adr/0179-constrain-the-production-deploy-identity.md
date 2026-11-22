# ADR-0179: Constrain the production deploy identity

- Status: Accepted; implementation pending
- Date: 2026-11-20
- Related: [#58](https://github.com/AiHub-Ecosystem/aihub-be/issues/58), [#434](https://github.com/AiHub-Ecosystem/aihub-be/issues/434), [ADR-0079](0079-managed-nginx-configuration-on-shared-vps.md), [ADR-0165](0165-production-availability-and-single-host-risk.md)

## Context

The production deploy account can currently obtain root through Docker and other sudo rules. The VPS is shared by AIHUB and unrelated sites and containers, and the CD SSH key reaches this account. A read-only `sudo -l` check on 2026-11-20 confirmed passwordless access to Docker, dockerd, `/var/www/autonginx.sh`, plus root commands for package management, Certbot, editors, and nginx. The host showed 14 enabled nginx site entries and 20 running containers. The account is therefore root-trusted in practice, regardless of commands rejected by the sudo policy.

The CD workflow uses `sudo docker` throughout deployment and operations, so removing Docker privilege before migrating and rehearsing that workflow would break deployment. A root-owned nginx helper remains a separate privileged boundary; issue #434 documents that it is not yet safe against staged-file races and foreign host/certificate configuration.

## Decision

- Treat the production deploy identity as constrained and remove its general root access.
- Migrate AIHUB deployment to a rootless Docker daemon owned by the deploy identity. Verify the full CD deploy and rollback path before changing production sudoers.
- Remove deploy-user sudo access to Docker/dockerd, package managers, `dpkg`, Certbot, root editors, general nginx/systemctl commands, and `/var/www/autonginx.sh`. Host maintenance and publishing new hostnames/certificates remain operator-run through a separate supervised path.
- Keep only the fixed, no-argument AIHUB nginx apply helper as a possible deploy-user sudo entry. Do not enable CD invocation until #434's staged-file and host/certificate allowlist protections are implemented and verified.
- Preserve the current production access policy until the rootless deployment has been rehearsed. This ADR records the target decision; it does not attest that the live VPS has changed.

## Consequences

The deploy identity and a compromised CD key will no longer have a supported route to host root after implementation. Rootless Docker requires changes to container networking, persistent mounts, service startup, logging, monitoring, and nginx upstream access to be checked against the production deployment. Host package updates and hostname/certificate changes need an operator path. The current sudo policy remains a root-equivalent risk until migration is complete; #58 stays open for implementation evidence, and #434 remains the prerequisite for enabling the privileged nginx helper.
