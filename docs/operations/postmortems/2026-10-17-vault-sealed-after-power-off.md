# Postmortem: shared Vault sealed after the host was powered off, 2026-10-17

Blameless. Times are UTC. Severity: SEV2, assigned afterwards. First posted on
#293 on 2026-10-18; moved here when #293 set the postmortem location.

## Summary

The production VM was powered off from outside at 2026-10-17 17:41 and booted
at 18:11. The shared Vault came back sealed, as a Shamir-sealed Vault does,
and nobody could find the unseal shares. Nothing alerted. The seal was found
8 h 23 min after the boot, when CD refused to deploy because the Vault Agent had
not authenticated within an hour. Because the old Vault could not be unsealed,
it was re-initialized on a new volume, and every secret was restored from the
copies its consumers still held. Deploys resumed at 04:13, about 10 h after the
boot.

## Impact

- **Customers:** no evidence of an impact beyond the 30-minute power-off itself.
  AIHUB kept serving on the secrets the Vault Agent had rendered to disk before
  the power-off. This was not measured, because no external probe ran yet
  (#291).
- **Releases:** every CD run from 02:34 to 03:24 failed or was held. Deploys
  were blocked for about 1 h 40 min from detection, about 10 h from the boot.
- **Rotation and restarts:** for 9 h 19 min, no secret could rotate, and no
  consumer that reads Vault only at startup could have restarted. That includes
  another team's bots that share this Vault.
- **Data:** the old Vault's storage is kept but cannot be read without the lost
  shares, and so are its snapshots. AIHUB's three rendered bundles were
  restored byte for byte, and the other consumers' secrets were restored from
  their running configuration. A Vault-only value that no consumer held would
  be lost. None was found missing.

## Timeline

| Time (UTC)  | Event                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-17 17:41 | The VM is powered off through the hypervisor's guest agent: from the hosting control panel or by the provider. The shutdown is clean.                     |
| 10-17 18:11 | The VM boots. Containers restart. Vault starts sealed. The Vault Agent keeps reporting `healthy`, because its check only tests the rendered files (#794). |
| 10-18 03:00 | The Vault snapshot job runs against the sealed Vault and saves an error response as a `.snap` file: the silent-failure mode #364 predicted.               |
| 02:34       | **Detection.** CD's Vault gate refuses to deploy: the agent has not authenticated in the last hour. Two more runs fail the same way.                      |
| ~02:45      | The unseal shares cannot be located. Decision: re-initialize Vault on a new volume and keep the old one untouched.                                        |
| 03:26       | Vault is re-initialized and unsealed. KV, AppRole, audit, and policies are recreated.                                                                     |
| 03:30       | The AIHUB Vault Agent authenticates again. The rendered files are byte-identical to the previous ones.                                                    |
| 03:33       | First valid snapshot from the repaired snapshot job.                                                                                                      |
| 03:24–04:13 | CD is held: a release merged during the incident needed a Sandbox Vault tier that the new Vault does not have (#351). That release is reverted.           |
| 04:13       | The revert deploys successfully to Production and Sandbox.                                                                                                |

## What went wrong

1. **Custody of the unseal shares was never recorded** (#364). This one gap
   turned a routine restart into a rebuild.
2. **Nothing alerts on a sealed Vault, an agent that cannot authenticate, or a
   host reboot** (#794, #798, #474, #291). Detection depended on someone trying
   to deploy.
3. **The agent's health check reported `healthy` for the whole incident**
   (#794).
4. **Backups did not help.** A snapshot of a Shamir-sealed Vault cannot be
   restored without the shares, and the snapshot job saved an error as a
   success (#364).
5. **The VM can be stopped from an account outside every AIHUB control, and
   nobody was told it was stopped.** Nobody owns host reboots either, so the
   restart was unplanned and unannounced (#381, #362).
6. **A release depended on Vault provisioning that did not exist yet**, which
   held deploys a second time after Vault was back (#351).

## What went well

- Rendered secrets on disk kept AIHUB serving through the seal. This is in
  tension with #414 (secrets only in memory), and the two decisions need to be
  made together.
- CD's Vault gate caught the problem before a release could start on stale
  secrets.
- Every secret was recovered from the copies its consumers held, and the old
  storage was kept rather than overwritten.

## Follow-ups

- #364: recovery, share custody, and off-host snapshots.
- #798: seal decision; a Vault-availability alert whichever way it goes.
- #794: agent health and alert.
- #474: a host-reboot alert.
- #291: probe and heartbeats (closed).
- #362: reboot owner and window, and announcing provider-side actions.
- #381: the control-panel account.
- #351: Sandbox Vault tier.
- #396: reboot drill evidence (closed).
- #414: decide together with #798.
- #361: no standing root token.

## Gaps found in the incident process

- No one was paged. The responder was whoever happened to be deploying.
- No severity was declared and no customer message was considered. The impact
  assessment above was made afterwards.
- There was no agreed place for this postmortem. #293 set it.
