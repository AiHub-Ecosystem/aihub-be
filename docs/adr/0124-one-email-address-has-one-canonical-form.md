# ADR-0124: One email address has one canonical form

- Status: Accepted
- Date: 2026-10-23
- Related issue: [#394](https://github.com/AiHub-Ecosystem/aihub-be/issues/394)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (which addresses a Delivery Request can be written for)

## Context

Email normalization applied Unicode NFC, trimmed, lower-cased, and checked a loose `local@domain.tld` shape. It accepted non-ASCII local parts and internationalized domains as typed. That left three problems:

- **One mailbox, two identities.** `user@bücher.de` and `user@xn--bcher-kva.de` reach the same mailbox but were different strings, so both could register as separate User Accounts. An Organization Invitation sent to one form could not be accepted by an account registered with the other, because acceptance compares normalized addresses.
- **Look-alike addresses.** A Cyrillic `а` inside an otherwise Latin address looks the same in an invitation and in the audit trail. An owner could invite what looks like a colleague and send the Organization Invite Token to someone else's mailbox.
- **Undeliverable addresses.** A non-ASCII local part needs SMTPUTF8 end to end. When the provider refuses it, registration leaves a pending account whose Verification Token can never arrive, and the Email Delivery Request ends `failed`.

A fullwidth domain such as `ｅｘａｍｐｌｅ.com` also passed the old label rule as a second spelling of `example.com`.

## Decision

An address is `local@domain`. Both parts are normalized by `normalizeEmail`, which registration, login, verification resend, password recovery, and invitation sending all call, so two forms of one address cannot both exist. The check runs before any rate limit is spent or any account is looked up.

- **The local part is lower-cased ASCII** made of the RFC 5322 atom characters and single dots between atoms, at most 64 bytes, after NFC and lower-casing. A non-ASCII local part, a quote, a space, or an edge or doubled dot is refused. This is what a provider delivers without SMTPUTF8.
- **The domain is its IDNA form** (UTS 46, ASCII and punycode), produced by the WHATWG host parser that the runtime provides as the global `URL`. Case, fullwidth forms, decomposed characters, and Unicode all map to the same ASCII domain, which is what is stored and compared. Before the parser sees it, the domain may hold only letters, marks, numbers, dots, and hyphens, so a percent escape, a slash, a colon, an emoji, or an ideographic full stop cannot make it read a different host than the one typed.
- **A domain label that mixes scripts is refused**, whether the address was typed in Unicode or given as punycode. Scripts that are written together stay allowed: Han with Hiragana and Katakana, and Han with Hangul. Digits, hyphens, and combining marks do not count as a script. A combining mark left after NFC in a Latin, Cyrillic, or Greek label is refused, because those scripts have a precomposed form for every letter and a leftover mark is an overlay such as a slash through an `o`.
- **A punycode label must decode to something Unicode would show.** The domain layer decodes it itself (RFC 3492) so that it needs no runtime module: a label that does not decode, decodes to pure ASCII, or decodes to anything other than lower-case NFC letters, marks, and numbers is refused.
- **Other label rules.** A label is at most 63 bytes, may not carry hyphens in its third and fourth places unless it is punycode, and may not start or end with a hyphen. The top-level domain is two or more letters, or a punycode label; a numeric one is refused because the host parser reads `0x7f.1` as the IPv4 address `127.0.0.1`.
- The whole address is at most 254 bytes after normalization.

An address the rule refuses gets the existing `400 INVALID_REQUEST` validation error. The error depends on the input alone, so it names no account, and on the generic routes (verification resend, password recovery) the reply is the same for known and unknown addresses. No new error code is introduced.

### Existing data

Stored addresses are not rewritten. A deployment that holds an address the rule would change or refuse must rewrite or remove it before this ships, because login looks the normalized address up by equality and would no longer find it. An Organization Invitation stored in an old form cannot be accepted by an account in the new form; invitations live for 24 hours, so they expire and are sent again.

The check to run before shipping, read-only, counts the rows the rule would change or refuse: the local part must match the atom pattern, and the domain must be lower-case ASCII labels with a top-level domain of two or more letters and no `xn--` label. On 2026-10-23 Production held 6 identities and 0 invitations, all pure ASCII, and none would change or be refused.

## Considered Options

- **ASCII only.** Rejected: it turns away people whose own domain is internationalized, for no gain in safety over mapping the domain to its ASCII form.
- **Normalize the domain, keep the local part ASCII, refuse mixed scripts (chosen).** Every accepted address is deliverable without SMTPUTF8 and has one spelling.
- **Full internationalized email.** Rejected for now: it needs a provider that supports SMTPUTF8 end to end, and it still needs the mixed-script rule.
- **Import `node:url` into the domain layer for the conversion.** Rejected: the domain layer does not import runtime modules. The global `URL` and a small decoder keep it pure, at the cost of about sixty lines of RFC 3492.

## Consequences

- A person whose address has a non-ASCII local part cannot register or be invited until the provider path supports SMTPUTF8.
- The conversion depends on the runtime's host parser, so a runtime upgrade can change what a rare label maps to. The domain specs pin the mapping for the cases that matter.
- **A label made entirely of look-alike letters from one script is not caught.** A fully Cyrillic label under an ASCII top-level domain passes, because the rule compares scripts inside a label, not a label against its Latin skeleton. Closing that needs the Unicode confusables table and a choice of what to compare against, and is not part of this decision.
- Scripts outside the compared list count as one more script, so two unlisted scripts in one label are not told apart.
- The domain is stored as punycode, so the Customer Web shows a Unicode domain as a display concern and does not store it.
- The rule runs on every login attempt; it is a pure string operation and costs microseconds.
