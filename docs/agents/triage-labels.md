# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Priority labels

Priority is a separate axis from the triage role above: the triage role says whether an issue is ready and for whom, the priority says how soon it matters. An open issue carries one triage role and at most one priority label. An open issue with no priority label has not been prioritised yet.

| Label | Meaning                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| `P0`  | Blocks launch to real customers: exploitable, loses data, bills wrongly, or a failure cannot be detected or recovered |
| `P1`  | Do right after launch: a real risk that needs a precondition before it can cause harm                                 |
| `P2`  | Should do: improves reliability, operability, or code structure                                                       |
| `P3`  | When time allows, or waiting for a trigger the issue records                                                          |

Judge priority by the consequence if the issue stays open, not by effort. The P0 set is the launch gate tracked in [#416](https://github.com/AiHub-Ecosystem/aihub-be/issues/416); moving an issue into or out of `P0` updates that list too.
