# ADR-0129: Public routes follow one naming and response convention

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-29 in [#305](https://github.com/AiHub-Ecosystem/aihub-be/issues/305).
- Date: 2026-10-29
- Related: [ADR-0014](0014-ai-speaking-d2-contract-boundary.md), [ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [#305](https://github.com/AiHub-Ecosystem/aihub-be/issues/305), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)

## Context

The published `/v1` surface mixes styles inside one domain. Writing grades at `…/task2/grade`, a verb; Speaking grades at `…/speaking/grading`, a noun. Grading lives under `/v1/ielts/…` while audio upload lives under `/v1/speaking/…`. Withdrawing an API key and removing a member answer `200` with a body, closing an invitation answers `204`. `/v1/organizations/me/members` sits beside `/v1/organizations/{organization_id}/members`.

Renaming or removing a route is a breaking change, and the compatibility gate refuses it inside a supported major (ADR-0127). A convention is therefore cheapest while few customers have integrated, and it can only bind routes added from now on.

## Decision

- The convention binds new routes. Every route that predates it stays as published; the ones that break a rule are listed, each with its reason and the rules it may break, in `src/catalog/public-route-convention.spec.ts`. No route is renamed inside `/v1`. Tidying the older names may ride the first `/v2` release if the owner chooses to make it the concrete breaking change `/v2` waits for (#1374).
- **Actions.** An action that is not create, read, update, or delete is `POST …/<verb>` under the resource it acts on (`complete`, `refresh`, `rotate`, `transfer`). A graded operation ends in `/grade`.
- **Prefixes.** Exam content is `/v1/ielts/<skill>/…`: grading, prompts, and the Task 1 chart. An asset that belongs to a skill rather than to one task is `/v1/<skill>/…`; today that is Speaking audio only. A new top-level segment after `/v1` is a decision, made by adding it to the spec and to this record.
- **Deletes.** A `DELETE` answers `204` with no body when the resource can no longer be read, and `200` with the resulting state when the record remains with a `status` (a revoked API key, a removed member). That `status` is always present: the response schema requires it, so an optional `status` does not meet the convention.
- **`me`.** `/v1/me/…` is the caller's own resources. `/v1/organizations/me/…` is a view across the caller's Organizations. Anywhere else a path names the Organization or user explicitly.
- Out of scope: the answer to a request with an unsupported method. It stays `404 NOT_FOUND` by design, with the reasons in [ADR-0135](0135-a-method-a-route-does-not-accept-answers-404.md).

## Consequences

The Speaking job planned in ADR-0014 at `POST /v1/speaking/grade` does not fit the prefix rule. When it is added it joins the exception list and cites ADR-0014, or this record is amended.

The spec enforces the grading verb, the prefix set, the delete rule, and the `me` placement. The rule that other actions are `POST …/<verb>` cannot be checked from the registry and is held by review. Because the exception list is checked in both directions, a route cannot be excused after it starts following the rules.

## Confirmation

`src/catalog/public-route-convention.spec.ts` runs over `PUBLIC_ROUTES` and `OPERATION_CATALOG`. It fails for a new route that breaks a rule, for a break on an excepted route that its exception does not list, for a listed rule the route no longer breaks, for an exception whose route now follows the rules, and for an exception that names no route. A `DELETE` that answers `200` passes only when `data.status` is required by the response schema.
