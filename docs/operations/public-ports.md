# Public ports

What each AIHUB host may serve to the internet, how an unexpected open port is
detected, and the default-deny layer that keeps a container port private unless
it is listed (#464).

Docker writes its own iptables rules. A `ports:` line in any project's compose
file publishes that port to the internet past ufw, and on 2026-10-11 one such
line exposed a production database for about 23 hours. Two layers answer that:

| Layer     | What it does                                                                                       | Script                                         |
| --------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Detection | An hourly scan from the other host alerts on any open TCP port that is not on the host's allowlist | `scripts/ops/monitoring/probe-public-ports.sh` |
| Guard     | A chain in `DOCKER-USER` drops traffic from the public interface to any unlisted container port    | `scripts/ops/firewall/docker-user-guard.sh`    |

## Allowlists

`ops/firewall/production.allow` and `ops/firewall/monitoring.allow` list every
port the host may serve, with an owner and a reason per entry:

```text
<proto>/<port> [from=<cidr>] <owner>: <reason>
```

A port is public only when it is in this file. To make a port public, add it in
a reviewed change, with the project that needs it as its owner, then copy the
file to the host (below). The register of shared infrastructure
([shared-infrastructure.md](shared-infrastructure.md), #362) refers here for
public ports.

Known exposures that are waiting for their owners are not written in the
repository, which is public. They go in a host-local **pending file**, one
`<proto>/<port>` per line with a comment naming the owner and the issue:
`~/.aihub-public-ports-<label>.pending` on the probing host. The probe tolerates
a pending port; the guard does not. Remove a line once its port is closed or
moved to the allowlist.

## Detection: the external probe

`probe-public-ports.sh <label> <allowlist> <address>...` runs a rate-limited
TCP connect scan of all 65535 ports on each address through a pinned nmap
image, then compares the open ports with the allowlist and the pending file.
Each address takes about 7 minutes. A SYN scan at nmap's `-T4` missed open
ports on 2026-10-19, so the scan is slower on purpose.

It runs on the other host, so the scan crosses the internet:

| Probed host | Runs on         | Task                      |
| ----------- | --------------- | ------------------------- |
| Production  | Monitoring host | `public-ports-production` |
| Monitoring  | Production      | `public-ports-monitoring` |

The result is written in the scheduled-job format to the probing host's node
exporter, so the existing rules alert
([Scheduled jobs](aihub-observability.md#scheduled-jobs)):

- `AIHUBScheduledJobFailed`: an unexpected open port, a failed scan, or a scan
  that saw none of the allowed ports (a blocked or broken scan is not a clean
  one).
- `AIHUBScheduledJobMissed`: no successful run for 3 hours.

The failure detail, including the address and the unexpected ports, is in
`~/aihub-public-ports.log` on the probing host, never in the metric.

Host setup, once per probing host:

1. Copy `scripts/ops/monitoring/probe-public-ports.sh` (mode `0755`) and the
   probed host's allowlist into `~/aihub-firewall/`.
2. Write the pending file for exposures already known, so the first run alerts
   only on something new.
3. Add one crontab line outside the `AIHUB MANAGED JOBS` block, which CD
   rewrites. Use the probed host's public IPv4 and IPv6 addresses:

   ```sh
   17 * * * * AIHUB_HOST_JOB_METRICS_DIR=<node-exporter-textfile-dir> $HOME/aihub-firewall/probe-public-ports.sh <label> $HOME/aihub-firewall/<label>.allow <ipv4> <ipv6> >/dev/null 2>&1
   ```

   The textfile directory is `~/.aihub-host-job-metrics` on Production and
   `~/aihub-monitoring/host-job-metrics` on the monitoring host.

4. Run the line once by hand and check that the success series for the task
   appears in Prometheus. A task that never succeeded cannot alert as missed.

## Guard: default-deny for container ports

The guard keeps one chain, `AIHUB-PUBLIC-INGRESS`:

- **IPv4**, jumped from the top of `DOCKER-USER`: traffic from the public
  interface reaches a container only when its original destination port is on
  the allowlist (and from the listed source, for a `from=` entry). Replies to
  connections the containers opened, and all traffic not on the public
  interface (container to container, the host's own loopback), pass.
- **IPv6**, jumped from `INPUT`: with Docker's IPv6 off, `docker-proxy` answers
  published ports on `[::]` as a host process, so each published port that is
  not on the allowlist is dropped there. The list of published ports is re-read
  on every pass.

It does not filter host processes such as sshd, nginx, or any service started
outside Docker. Those are found by the probe and closed by their owners.

The guard runs as a container with the host's network and `NET_ADMIN`
(`ops/firewall/guard.compose.yml`). In `watch` mode it re-applies the rules every
minute, which restores the jump if Docker or anyone else rewrites
`DOCKER-USER`; its restart policy starts it again after a reboot. It refuses to
run unless iptables uses the `nf_tables` backend the hosts use.
`scripts/ops/firewall/docker-user-guard.spec.sh` checks the rules in a throwaway
network namespace in CI.

### Prepare (changes nothing)

Copy `ops/firewall/guard.compose.yml`, `ops/firewall/guard.Dockerfile`,
`scripts/ops/firewall/docker-user-guard.sh`, and the host's allowlist (renamed
`public.allow`) into one directory on the host, then print the plan:

```sh
sudo -n docker compose -f guard.compose.yml build
sudo -n docker compose -f guard.compose.yml run --rm public-ingress-guard plan /etc/aihub/public.allow
```

The last section of the plan lists the published container ports the rules
would cut off from the internet. Send that list to the owners before enabling.

### Enable

Only after every owner on the plan's list has been told and has either moved
their port to `127.0.0.1` or had it added to the allowlist:

1. Keep a second SSH session open. sshd is a host process and is not filtered,
   but a session is the way back if something unexpected happens.
2. Start the guard: `sudo -n docker compose -f guard.compose.yml up -d`.
3. Verify from outside the host:
   - Each port that was cut off is refused.
   - A throwaway container published on an unlisted port is refused without a
     rule written for it:
     `sudo -n docker run -d --rm --name guard-test -p 0.0.0.0:47999:80 nginx:alpine`,
     probe `47999` from the other host, then `sudo -n docker stop guard-test`.
   - Every allowlisted port still answers.
4. Verify inside the host: `ops/status.sh` reports both AIHUB tiers healthy
   with `/ready` 200 (database and Redis reachable), and the AIHUB scrape
   targets are `UP` in Prometheus.
5. Run the probe once by hand and confirm it records success.

### Disable

```sh
sudo -n docker compose -f guard.compose.yml down
sudo -n docker compose -f guard.compose.yml run --rm public-ingress-guard remove /etc/aihub/public.allow
```

Stopping the container leaves the last rules in place; `remove` takes them out.

### Change the allowlist

Edit the file in the repository, copy it to the host as `public.allow`, and wait
one minute: `watch` re-reads it on every pass. Update the probing host's copy at
the same time, or the probe alerts on the newly allowed port.
