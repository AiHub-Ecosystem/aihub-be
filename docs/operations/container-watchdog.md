# Container watchdog

Docker restarts a container whose process exits. It never restarts one whose
healthcheck reports `unhealthy`, and Compose has no orchestrator that would.
`scripts/ops/host-jobs/container-watchdog.sh` covers that gap on the
production host (#396). The managed crontab (`ops/host-jobs/aihub.crontab`)
runs it every minute. CD syncs it and suspends it with the other host jobs
while it deploys.

The same run checks that runtime secrets can still be rendered (#825); see
[Secret delivery](#secret-delivery).

It needs no access beyond what CD already uses: `sudo -n docker` as the
deploy user.

## What it does each run

1. It reads `docker ps` for the `aihub-production` Compose project and watches
   `app`, `app-slot-b`, `app-sandbox`, `app-sandbox-slot-b`, and `vault-agent`.
2. It restarts an app container that Docker reports `unhealthy`, with
   `docker restart -t 30`. The app healthcheck fails 12 times, 10 s apart,
   before Docker marks the container unhealthy. A container that stops
   answering `/health` is therefore restarted about 2 to 3 minutes later.
3. It allows at most 3 restarts per container in any hour. After that it logs
   `restart_skipped ... reason=limit` and stops restarting that container.
   The container then stays unhealthy, which raises
   `AIHUBContainerStillUnhealthy`.
4. It never restarts `vault-agent`, because Agent restarts stay
   operator-managed (`deploy-vps.md`). An unhealthy Agent is only reported.
5. It reads the Docker events and the kernel log since its last run and
   counts these:
   - `unhealthy`: a transition to unhealthy
   - `oom`: an OOM kill, taken from the kernel's `oom-kill:` line, which
     names the container's cgroup. Docker's own `oom` event is not used: on
     the production host's cgroup v2 it reported one of three OOM kills in
     the #396 drill, and cAdvisor's counter reported none. The deploy user
     reads the kernel log with `journalctl -k`, without `sudo`.
   - `exit`: a `die` with no stop request, with its exit code
   - `watchdog_restart`: a restart it made itself

   A `die` that follows a stop request is expected and is not counted. A
   deploy, `docker restart`, or `compose down` makes that kind of stop
   request.

The log is `~/aihub-container-watchdog.log`. Its state is in
`~/.aihub-container-watchdog/`: one restart history per container, the event
counts, and the time of the last events read.

## Metrics

The node-exporter textfile collector reads these from
`$AIHUB_HOST_JOB_METRICS_DIR` (see `aihub-observability.md`):

| Series                                                                        | Meaning                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `aihub_container_events_total{name,revision,event,exit_code}`                 | Events counted since the series first appeared                      |
| `aihub_container_last_event_timestamp_seconds{name,revision,event,exit_code}` | Time of the latest such event                                       |
| `aihub_container_unhealthy{name,revision}`                                    | 1 when unhealthy and not restarted in this run, otherwise 0         |
| `aihub_host_job_last_success_timestamp_seconds{task="container-watchdog"}`    | Heartbeat, 5-minute window (`AIHUBScheduledJobMissed`)              |
| `aihub_secret_delivery_last_healthy_timestamp_seconds`                        | Last run at which runtime secrets could be rendered                 |
| `aihub_secret_delivery_healthy{reason}`                                       | 1 with `reason="ok"`, otherwise 0 with the failure reason           |
| `aihub_runtime_secrets_modified_timestamp_seconds`                            | When the rendered bundle's content last changed                     |
| `aihub_runtime_secrets_restart_required{name,revision}`                       | 1 when the app started before the bundle last changed               |
| `aihub_ssh_auth_failures_total`                                               | Failed SSH login attempts counted by the watchdog                   |
| `aihub_ssh_unexpected_login_timestamp_seconds{user,key,reason}`               | Last password login, or first login with a new key, in the past day |

`revision` is the image's `org.opencontainers.image.revision` label. A series
is dropped 7 days after its last event, so the state does not grow with every
deployed revision. To count OOM kills over a day:

```promql
sum by (name) (increase(aihub_container_events_total{event="oom"}[1d]))
```

Docker replays only its last 256 events. Healthcheck exec traffic fills that
buffer in about two minutes, so the watchdog misses events from a longer gap,
such as a deploy that holds the schedule.

## OOM kill

`AIHUBContainerOOMKilled` (critical) fires for 15 minutes after an OOM kill.
Every request in flight on that container was dropped, and Docker has already
restarted it. Check `docker inspect` for the memory limit (`mem_limit: 768m`
for the app). Then check the Speaking upload size that #268 and #270 describe,
and the request log around the event time.

## Disruption

`AIHUBContainerDisrupted` (warning) fires for 15 minutes after any of these
events:

- an exit with no stop request, with its exit code
- a transition to unhealthy
- a watchdog restart

Read the container's logs from before the event:

```bash
sudo -n docker logs --since 30m <name>
```

An exit code of 137 with no matching OOM alert means something else killed
the container with SIGKILL.

## Still unhealthy

`AIHUBContainerStillUnhealthy` (critical) fires when a watched container has
been unhealthy for 3 minutes and the watchdog has not restarted it. There are
three possible causes:

- **`vault-agent`.** Follow the Vault Agent sections in `deploy-vps.md` before
  any restart.
- **The restart limit.** Restarting does not cure the fault, so find the cause
  in the logs before you restart the container by hand. The limit resets an
  hour after the first of the three restarts.
- **`restart_failed` in the watchdog log.** The restart itself failed. The
  same run also raises `AIHUBScheduledJobFailed` for `container-watchdog`.

## Secret delivery

Vault Agent renders the runtime secret bundle into
`$AIHUB_RUNTIME_SECRETS_HOST_DIR`, and both app tiers read it once at start.
The Agent re-reads its static KV secrets every 5 minutes but rewrites a file
only when the content changes. As a result, neither the file age nor the
Agent's health check shows whether rendering still works. The Agent's own
metrics are no help either, because it keeps them for one minute. When
delivery stops (#203 and #794), the app keeps running on what it loaded at
start, until a rotation or a restart needs a fresh render.

Each run of the watchdog checks two conditions inside the `vault-agent`
container:

- `vault status` reports Vault unsealed.
- The Agent logged no `[ERROR]` line in the last 10 minutes. The window is
  longer than the Agent's 5-minute maximum retry backoff, so a failure that
  keeps retrying is not read as healthy between two retries.

When both hold, the run counts as healthy and moves
`aihub_secret_delivery_last_healthy_timestamp_seconds` forward. Otherwise the
run records one of these reasons:

- `vault_sealed`
- `vault_unreachable`: Vault did not answer, or the Agent container could not
  be queried.
- `agent_error`
- `agent_unavailable`: the Agent's log could not be read.

Every change of reason is written to the watchdog log as
`secret_delivery reason=...`.

`AIHUBSecretDeliveryStalled` (warning) fires 15 minutes after the last healthy
run: the 5-minute render interval plus 10 minutes of margin.
`AIHUBSecretDeliveryStalledLong` (critical) fires after an hour. No secret in
the bundle has an expiry that Vault manages, because they are all static KV v2
versions, so there is no expiry point to page on. The hour bounds how long a
rotation or a fresh render can fail without anyone being paged.

Handle it in this order:

1. Read the reason in the alert, then confirm it:

   ```bash
   sudo -n docker logs --since 30m <vault-agent container>
   ```

2. `vault_sealed`: Vault must be unsealed by the key holders. The procedure is
   kept outside this repository. Do not restart the Agent or the apps while
   Vault is sealed. The apps keep their loaded snapshot, but a restarted app
   has only the files on disk, and a restarted Agent cannot render.
3. `agent_error` or `vault_unreachable` with Vault unsealed: fix the cause the
   Agent logs, such as a policy refusal (`403`), a network failure, or an
   authentication failure. Agent restarts stay operator-managed (see "Start
   the Vault-backed stack" in `deploy-vps.md`). Restart the Agent only after
   its cause is fixed, and confirm it is healthy and that the files are
   present.
4. Once delivery is healthy again, check `AIHUBRuntimeSecretsRestartRequired`.
   The apps pick up a changed bundle only when they restart.

## Restart required

`AIHUBRuntimeSecretsRestartRequired` (warning) fires when an app container
started before the rendered bundle last changed and has kept running for 5
minutes. The app reads secrets only at start, so a credential written since
then is not in use. Follow "Rotation and rollback" in
`vault-runtime-secrets.md`: restart the instances gradually, then check health
and one safe downstream request.

After a host reboot, the Agent can rewrite an identical bundle after an app
has started. That case also raises this alert, and one restart of the app
clears it.

## SSH logins

sshd on the production host accepts keys only (#570, "SSH access" in
`deploy-vps.md`). Each run reads the sshd journal since the previous run. The
deploy user can read it through group `adm`. The run reports three things:

- **`AIHUBSSHPasswordLogin` (critical).** sshd accepted a password, which the
  configuration should make impossible. Check `sshd -T` and the drop-in file
  first, then check who logged in.
- **`AIHUBSSHNewKeyLogin` (warning).** A key logged in that has not logged in
  before for that account. On its first run the watchdog learns the keys used
  in the last 30 days without reporting them, in
  `~/.aihub-container-watchdog/ssh-known-keys`. Confirm whose key it is. If it
  is unknown, remove it from that account's `authorized_keys`.
- **`AIHUBSSHAuthFailureBurst` (warning).** More than 50 failed attempts in 10
  minutes. In the week before #570 the normal rate stayed far below that,
  except for two scans of about 80 to 95 attempts. sshd already penalizes each
  source on its own. The alert shows a scan, or a key holder who is locked
  out.

A login from a new source address is not reported. The maintainer's ISP hands
out a new address almost daily: one key logged in from 22 addresses in a week.
CI logs in from a new cloud address on every run: 101 addresses in the same
week. An address alert would therefore fire several times a day. A stolen key
is reported when it is first used from an account that has never used it.
Otherwise it looks like its owner's key from a new address, which this check
cannot tell apart.
