# Customer Web: identity configuration onboarding

Status: planned. Backend support lands in #155 (read), #157 (set), and #156
(clear error). This note tells the Customer Web team how the onboarding flow
should use them. The customer-facing integration steps stay in
[integration-guide.md](integration-guide.md); update its "Onboarding lifecycle"
section when #157 ships, because owners will no longer need AIHUB to register the
identity configuration for them.

## Why this step exists

Every grading operation (Writing Task 1/Task 2 and both Speaking routes) is
user-scoped and requires `X-User-Identity`. AIHUB verifies that assertion with
the Organization's identity configuration: an issuer plus either a JWKS URL or
an inline public JWKS. An Organization without one has a working API key but
cannot grade anything.

## Do not require it at Organization creation

Keep the step optional and skippable:

- The person who creates the Organization is often not the engineer who owns
  the signing keys, and the signer may not exist yet.
- Creating the Organization, inviting members, and creating API keys do not
  need an identity configuration. Only real grading calls do.
- Sandbox Organizations use AIHUB-minted assertions through the Customer Web,
  so they can try grading without their own keys.

## Flow

1. Register, verify email, create the Organization (name and basic details).
2. Onboarding shows a "Configure user identity" step with two options:
   - **JWKS URL** (recommended): the Organization rotates keys without
     touching AIHUB.
   - **Paste public JWKS**: fallback when the Organization cannot host a URL.
     Every key rotation then needs a new save.

   Both options also ask for the exact issuer. The step has a "Do this later"
   button.

3. Only the Organization `owner` can see or change this step. Admins and
   members see a read-only notice asking the owner to finish setup.
4. Until the configuration exists, the dashboard shows a banner: "Grading uses
   unsigned Declared User IDs. Set up user identity verification to prove which
   user is acting", linking to the settings page. Drive it from `GET /v1/organizations/:organizationId/identity-config`
   returning `configured: false`.
5. The API key creation screen shows the same reminder. It does not block key
   creation.
6. Without a configuration, grading still works: AIHUB accepts a Declared User
   ID in `X-User-Identity` (ADR-0053). Present signed verification as
   recommended, not required. Disabling an active configuration switches the
   Organization back to Declared User IDs, so warn the owner before confirming.

## Form behavior

- Save with `PUT /v1/organizations/:organizationId/identity-config`.
- AIHUB fetches a JWKS URL once while saving. Show a clear message when it is
  rejected (not `https://`, unreachable, not a public address, not a valid
  public JWKS). Do not suggest `http://`, localhost, or internal hosts; AIHUB
  blocks them on purpose.
- A `409` means another Organization already uses that issuer. Ask the owner to
  check the issuer value, not to retry.
- Never ask for, accept, or display a private key. Warn if the pasted JSON
  contains private JWK fields (`d`, `p`, `q`, `dp`, `dq`, `qi`); AIHUB rejects
  them.
- After a successful save, the next grading request uses the new keys. No
  waiting period is needed.
