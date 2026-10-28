# ADR-0121: An Organization name cannot turn an invitation email into phishing

- Status: Accepted
- Date: 2026-10-22
- Related issue: [#353](https://github.com/AiHub-Ecosystem/aihub-be/issues/353), [#334](https://github.com/AiHub-Ecosystem/aihub-be/issues/334), [#779](https://github.com/AiHub-Ecosystem/aihub-be/issues/779)
- Amends: [ADR-0041](0041-self-serve-organization-creation-boundary.md) and [ADR-0043](0043-organization-rename-boundary.md) (the Organization name rule, and its gap for operator-created names), [ADR-0074](0074-transactional-email-outbox.md) (the Organization Invitation email copy and payload), [ADR-0085](0085-per-tier-blue-green-cutover.md) (the scoped N-1 write exception below)

## Context

Any verified AIHUB User Account can create a Self-serve Organization, give it any name, and invite arbitrary addresses. The Organization Invitation Send Limit (ADR-0039) allows five invitations per inviting account per 15 minutes. Each invitation email is sent from AIHUB's verified sender and spends its reputation. Until now the email carried the name verbatim in its subject and in the first sentence of its body, so a name such as "Tài khoản của bạn đã bị khoá, truy cập …" turned the email into a phishing message signed by AIHUB.

Commit `a0effc91` (2026-10-17) already refuses C0 and C1 controls, the Unicode line and paragraph separators, and the bidirectional marks, embeddings, overrides, and isolates in Organization names at creation and rename, and in API key names (`isDisplayText`). Three gaps remain:

- invisible characters that let a name look identical to another one;
- the email copy, which still puts the name in the subject and does not say who sent the invitation;
- the operator `org:create` command, which inserts a name with no rule at all (the conflict ADR-0043 recorded).

On 2026-10-22 Production held five Organizations, none of which breaks the rule below, contains an invisible character, is untrimmed or longer than 100 characters, or looks like a URL. Sandbox held none.

## Decision

### One display-text rule for every owner-chosen name

An Organization name and an API key name share one rule. On top of what `isDisplayText` refuses today, it also refuses U+200B ZERO WIDTH SPACE, U+00AD SOFT HYPHEN, U+FEFF ZERO WIDTH NO-BREAK SPACE, and U+2060–U+2064 (word joiner and the invisible operators). The zero-width joiner and non-joiner and the variation selectors stay allowed, so emoji sequences still render.

An Organization name is still trimmed and then 1–100 characters long, shown as written, and not unique. A refused name at creation or rename answers the existing invalid-request error.

### Postgres refuses what the domain refuses

A `CHECK` constraint on `organizations.name` refuses the same characters, an untrimmed value, and a length outside 1–100. Its trim check uses the same ECMAScript whitespace set as `String.prototype.trim`, so direct writes must already provide the stored form. Its length check counts code points (`char_length`) while the domain counts UTF-16 units, so the database is the looser of the two, the safe direction. It is added `NOT VALID` and validated in a second migration. Because every write path passes through it, including the operator `org:create` command, the gap ADR-0043 recorded is closed without changing that script. The constraint lists the refused characters explicitly to mirror the TypeScript rule.

### The invitation email does not let the name speak for AIHUB

- The subject is fixed text, `Lời mời tham gia một tổ chức trên AIHUB`, and never carries the name.
- After the greeting, the body's first sentence is `<inviter username> mời bạn tham gia tổ chức “<name>” trên AIHUB với vai trò <role>.`, in the text and HTML parts alike. The quotation marks show which part someone else wrote, and the username shows who sent it. The composer replaces any curly quotation mark inside the name with a straight one, so a name cannot close the quotation early and write the rest of the sentence as AIHUB's own words; the stored name is unchanged. A username is limited to `[a-z0-9._-]`, 3–32 characters, so it carries no text of its own.
- The inviter's username is read inside the transaction that creates the invitation and sealed into the Email Delivery Request payload as `inviterUsername`. A request queued before this change has no such field and is still sent, with an opening sentence that omits the inviter. An invitation lives one day, so that branch stops mattering one day after deployment.

### Accepted risk: names that look like a URL

Names such as `evil.com` or `http://…` stay allowed. Refusing them would also refuse real names such as "Acme.io", and some mail clients turn `evil.com` into a link even inside quotation marks. The risk is accepted because of the fixed subject, the quoted name, the visible inviter, and the send limit. Production held no such name on 2026-10-22. Refusing URL-like names is a product decision that can be added to the same rule later.

### Scoped N-1 write exception for Organization names

This constraint is the narrow exception to ADR-0085's rule that a migrated
database accepts writes from both running releases. During the N-1 rollback
window, the previous application can still accept an Organization name that the
new database constraint refuses, including a name with U+200B ZERO WIDTH
SPACE. A create or rename with such a value may therefore fail at the database
boundary. The #755 release compatibility gate reports this named rejection as
an accepted exception; it does not count it as proof that all N-1 writes are
compatible. Other N-1 writes remain subject to the compatibility gate.

### API key names in the near-expiry notice

The ADR-0120 notice names API keys, whose names an owner or admin chose. It is sent only to owners and admins of the same Organization, so a key name never reaches another tenant, and the shared rule above already applies to it. It is left unchanged.

## Considered alternatives

- **Refusing URL-like names.** Closes the remaining phishing path but refuses legitimate names; deferred as a product call.
- **Escaping or normalising the name in the email only.** It leaves the stored name unsafe for every other surface that shows it, and for the operator path.
- **Applying the rule inside `org:create`.** The script is plain `.mjs` and writes SQL directly; a database constraint covers it and any future write path at once.

## Consequences

An invitation email no longer reads as AIHUB's own message when the name is hostile, and a recipient can see who invited them. A name AIHUB stores can no longer break a line, reverse text, or hide characters, whichever path wrote it. The rule also tightens API key names.

The invitation payload gains one field, and the handler accepts both shapes until the queued pre-change requests are gone. Any future write path that bypasses the domain is refused by Postgres, not left to be spotted later. During the deploy window the N-1 application still accepts a name such as one with a zero width space, so a create or rename that lands then can be refused by the constraint and answer a server error; Production holds five Organizations, so the window is accepted.
