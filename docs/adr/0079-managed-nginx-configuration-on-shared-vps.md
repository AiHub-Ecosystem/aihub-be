# ADR-0079: Managed nginx configuration on the shared VPS

- Status: Accepted
- Date: 2026-10-07
- Related: [#112](https://github.com/AiHub-Ecosystem/aihub-be/issues/112), [#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298)

AIHUB versions and deploys only dedicated API and Sandbox nginx files; the mixed host file stays outside the managed source so CD cannot overwrite another site's configuration. An operator performs the one-time extraction and installs a root-owned, fixed-path, no-argument helper; CD may invoke only that helper, which installs or removes the allowlisted AIHUB files, validates with `nginx -t`, reloads only on success, and rolls back on failure. This boundary limits accidental file scope but does not protect the shared VPS from a compromised CD identity while `sudo docker` remains root-equivalent; that risk belongs to #298.
