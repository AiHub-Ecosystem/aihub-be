# Production host

Read this before checking what is live in production, changing nginx, or assessing access to the host.

To check what is live on the production host (commit, health, errors since start), run `ops/status.sh` as `docs/operations/deploy-vps.md` describes under "Checking deployed state".

For nginx changes, read the "Managed nginx configuration" section in `docs/operations/deploy-vps.md` and inspect all of `sudo -l` before assessing access. Passwordless Docker or dockerd access is root-equivalent; verify the allowed commands before saying a root operator is required.
