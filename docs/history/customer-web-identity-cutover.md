# Customer Web identity cutover runbook (issue #94, ADR-0046)

> **Historical record.** This cutover ran in production and #94 is closed. The
> `pnpm migrate:cw` runner and its executor were removed in #337, so the commands
> below no longer exist; git history retains the tool. Keep this document for the
> reasoning and the shape of the export, dispositions, and evidence files — not
> as something to re-run.

Cutover moves the Customer Web sandbox from Clerk to AIHUB auth in one flip.
Rollback is a redeploy of the previous Customer Web image tag — not a
feature flag, not a data rollback. AIHUB-side accounts and memberships created
during a flipped window are never deleted by a rollback.

## 0. Prerequisites

1. The Customer Web repository is restored (`aihub-sandbox-demo`, private) and
   both login paths exist: local email/password (`aihub-be`) and Google OIDC
   (#93, including the BFF authorization-code handoff).
2. The sandbox organization already exists in AIHUB.
3. The operator-designated first owner has an **active** AIHUB account (email
   verified, password set), attached with the existing first-owner command.
4. Staging is ready: staging `aihub-be`, one staging Customer Web instance,
   Clerk dev keys, and a restored production database snapshot for the
   dry run.

## 1. Produce the Clerk export file

The migration command deliberately does **not** call the Clerk API directly:
without a captured Clerk response fixture the runner must not invent a
provider response shape. The operator produces a normalized export file:

```json
{
  "users": [
    {
      "clerkUserId": "user_abc",
      "email": "a@example.com",
      "membership": "active"
    },
    { "clerkUserId": "user_def", "email": null, "membership": "active" }
  ],
  "invitations": [{ "email": "b@example.com", "role": "member" }]
}
```

- One row per Clerk organization membership; `membership` is the Clerk-side
  membership state (`active` | `disabled`), taken from the Clerk roster, not
  inferred from presence.
- `pending` Clerk invitations go in `invitations` (roles owner/admin/member).
- Store this file **outside the repository**; it is PII.

## 2. Dry run against the snapshot and review

```text
pnpm migrate:cw --export ops/clerk-export.json --org org_sandbox \
  --owners boss@example.com --evidence ops/migration-evidence.json
```

- Prints `plan: created=N linked=N noop=N skipped=N quarantine=N invites=N readyToFlip=... digest=...`.
- The evidence file contains emails, the mapping (Clerk user → AIHUB account
  once applied), quarantine entries, and the invite reissue list. It also
  stays outside the repository; only aggregate counts and the digest enter
  the migration record.
- Every quarantine entry is printed as `quarantine: <clerkUserId> reason=...`
  with no email, so operator logs stay PII-free.

## 3. Resolve quarantine

Write dispositions (outside the repository) keyed by Clerk user id:

```json
{
  "user_def": { "kind": "skip" },
  "user_abc": { "kind": "link", "accountId": "usr_..." },
  "user_xyz": { "kind": "create" }
}
```

Re-run with `--dispositions`. Rerun dry runs until `readyToFlip=true`.
Rules of thumb: an email already owned by an AIHUB account must reuse it
(`link`) or be skipped — the runner refuses `create` there; a disabled-member
row is recreated as `disabled`, never dropped, so the disable decision
survives; a row whose existing membership already matches the plan is a no-op.

## 4. Flip

1. Deploy the new Customer Web image (no Clerk remains in it — verify with a
   grep of the build artifact). Clerk deployment secrets stay in place,
   unread, for the 14-day rollback window.
2. Re-export Clerk data immediately before the flip and re-run the script
   unchanged, adding `--apply`. Refusal (`blocked_quarantine`, exit 2) means
   new quarantine entries appeared: resolve and rerun; nothing is applied
   before the gate passes.
3. Owners with email delivery verify login works end-to-end (sign-in, roster
   membership, one live grading attempt), then re-issue pending invitations
   through the existing AIHUB invitation API from the owner account —
   invitation tokens live 24 hours, so this happens at the flip, not before.
4. All Clerk sessions are dead at the flip; users re-login fail-closed.

## 5. Rollback

1. Redeploy the previous Customer Web image tag. Clerk login, sessions, and
   memberships resume; nothing on the AIHUB side is deleted or rolled back.
2. Users who registered an AIHUB-only account during a flipped window keep
   that account; they simply cannot use it again until the next flip.
3. Prefer fix-forward for functional issues; reserve image rollback for
   auth outages or security problems. Keep the rollback window to 14 days.

## 6. Retire Clerk (+30 / +90)

- +30 days after a successful flip: export the Clerk directory to cold
  storage, set the Clerk instance read-only, and remove the Clerk variables
  from deployment configuration.
- +90 days: delete the Clerk instance and the cold export per the
  organization's retention agreement.

## Reference

- ADR-0046: `docs/adr/0046-customer-web-aihub-auth-identity-boundary.md`
- Acceptance-criterion wording (ADR-0021 amend vs supersede) is recorded as
  a conflict comment on issue #94; this runbook follows the ADR.
