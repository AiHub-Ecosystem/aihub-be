# nginx edge configuration (record)

`aihub.conf` and `sandbox.conf` are the files that run on the production VPS as
`/etc/nginx/conf.d/aihub.conf` and `/etc/nginx/conf.d/sandbox.conf`, captured
after the changes below. They are a **record, not yet a deployment
source**: nothing syncs them to the host. Bringing that under CD, with validation
before reload, is #112.

## What the AIHUB blocks do

- `api.aihubproduction.com` proxies to `127.0.0.1:3021` (Production) and
  `sandbox.aihubproduction.com` to `127.0.0.1:3022` (Sandbox), forwarding `Host`,
  `X-Real-IP`, and `X-Forwarded-For` (appended with `$proxy_add_x_forwarded_for`;
  see #139 for what that means for client-IP trust).
- `/metrics` and `/ready` answer 404 at the edge on both hostnames. Both stay
  reachable from inside the container for host-local monitoring (`ops/status.sh`
  uses `docker exec`). `/ready` also refuses non-loopback peers in the
  application, so the application does not depend on this rule for it.
- The API TLS blocks set HSTS for 180 days and hide the nginx version. The
  application owns `X-Content-Type-Options`, avoiding a duplicate edge header.
- `aihub.conf` also carries the apex `aihubproduction.com` block (another
  service on port 3000) and Certbot's port-80 redirects. They are kept so the
  file matches the host exactly; they are not AIHUB's.

## Applying a change by hand

Edit the file on the host, then validate before reloading:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

The deploy user can run `nginx -t` and `systemctl reload nginx` without a
password. CD still cannot sync these files because it has no permission to write
the nginx configuration (see #112 and #298).

## Change log

- 2026-10-07: added `location = /metrics` and `location = /ready` returning 404 in
  both blocks (#297). Verified from outside: `/metrics` and `/ready` 404, `/health`
  200, on both hostnames.
- 2026-10-07: added HSTS (`max-age=15552000`) and `server_tokens off` to the API
  and sandbox edge blocks; the API port-80 redirect block also hides the version.
  Validated the config with `nginx -t`, reloaded nginx, and verified public
  headers. `X-Content-Type-Options` remains app-owned.
