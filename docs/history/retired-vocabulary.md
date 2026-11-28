# Retired vocabulary from CONTEXT.md

> **Historical record.** These entries described the original invite-only,
> Clerk-era Customer Web sandbox. `CONTEXT.md` keeps only current vocabulary;
> the wording below is preserved as it appeared there, with relative ADR links
> adjusted for this location. It is a vocabulary record, not active behavior.

## Clerk-era entries

- **Customer User:** _Historical_: a person authenticated by the Customer Web through Clerk on the original invite-only flow; this was not an AIHUB account. A person signed in to the Customer Web today holds an AIHUB User Account.
- **Customer Organization:** the tenant concept in the Customer Web. During the invite-only sandbox MVP, all invited Customer Users belong to one Customer Organization mapped to the dedicated sandbox AIHUB Organization.
- **Clerk:** _Historical_: the Managed IdP of the original invite-only Customer Web sandbox. It is retired; the Customer Web signs in only through AIHUB ([ADR-0046](../adr/0046-customer-web-aihub-auth-identity-boundary.md), [issue #94](https://github.com/AiHub-Ecosystem/aihub-be/issues/94)).
- **Invite-only membership:** access granted by an operator to a known user; it remains the current sandbox membership path, while AIHUB local access uses explicit Organization Membership and local account registration does not grant Organization access.
- **Sandbox User ID:** an opaque deterministic identifier derived from the verified Managed IdP issuer and subject, encoded to AIHUB's `[A-Za-z0-9_-]` boundary; it is never an email address or a browser-supplied value.
- **Server-side session:** a Customer Web session represented to the browser only by a secure, HttpOnly, same-site cookie; provider access tokens do not live in browser storage. _Superseded_ for the Customer Web login session by **Web Session** [ADR-0081](../adr/0081-aihub-owned-customer-web-web-sessions.md); the term survives only to describe the browser-facing shape, not the session's owner or store.
- **Sandbox API key:** the server-held API key for AIHUB's dedicated demo Organization, distinct from the Organization-owned Sandbox keys that visitors may supply to the public demos; it is never sent to a browser.
- **Membership decision:** the active/disabled authorization result for a Customer User; the Customer Web evaluates it on every BFF request and may cache it for no more than five minutes in the sandbox MVP.
- **Per-request assertion:** a short-lived sandbox Signed User Assertion minted immediately before one grading call; it is never persisted or reused for another request.
- **Pass-through audio:** uploaded Speaking audio streamed from the Customer Web BFF to AIHUB and discarded after the response; it is not an MVP audio asset.
- **Sandbox-only deployment:** the first Customer Web release is configured only for AIHUB's sandbox hostname and credential; Production is absent until the production bridge is approved.
