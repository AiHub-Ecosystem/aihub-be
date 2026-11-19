# Retired customer-web identity vocabulary

Status: historical. These terms described the invite-only Customer Web sandbox before
the #94 cutover to AIHUB auth. They are kept here for readers of the historical ADRs
and cutover record; active vocabulary stays in [`CONTEXT.md`](../CONTEXT.md).

Source: the relevant entries were moved out of `CONTEXT.md` on 2026-11-19. See
[ADR-0046](../adr/0046-customer-web-aihub-auth-identity-boundary.md) for the decision
and [`customer-web-identity-cutover.md`](customer-web-identity-cutover.md) for the runbook.

## Retired terms

- **Customer User:** a person authenticated by the Customer Web through Clerk on the
  original invite-only flow; not an AIHUB account. A person signed in to the Customer
  Web today holds an AIHUB User Account.

- **Clerk:** the Managed IdP of the original invite-only Customer Web sandbox. Retired;
  the Customer Web signs in only through AIHUB
  ([ADR-0046](../adr/0046-customer-web-aihub-auth-identity-boundary.md),
  [issue #94](https://github.com/AiHub-Ecosystem/aihub-be/issues/94)).

- **Customer Organization:** the tenant concept in the Customer Web during the
  invite-only sandbox MVP, mapped to the dedicated sandbox AIHUB Organization. After
  the cutover, AIHUB Organization is the tenant concept.

- **Sandbox User ID:** the opaque deterministic identifier derived from the verified
  Managed IdP issuer and subject in the original invite-only flow. The public Writing
  and Speaking demos now use a temporary per-visit Declared User ID instead
  ([ADR-0094](../adr/0094-sandbox-demo-key-admission.md)).

- **Server-side session (historical sense):** the original invite-only Customer Web
  session with no custom session store. Superseded for the login session by **Web
  Session** ([ADR-0081](../adr/0081-aihub-owned-customer-web-web-sessions.md));
  the phrase still describes the browser-facing cookie shape, not the owner or store.

- **Membership decision (historical sense):** the active/disabled authorization result
  evaluated by the original invite-only BFF on every request with a five-minute cache.
  Signed-in Console requests today use AIHUB Web Session and Organization membership.
