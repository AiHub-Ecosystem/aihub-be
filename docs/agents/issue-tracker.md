# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <path>`
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body-file <path>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number>`. See [Closing an issue](#closing-an-issue) for what the comment has to show.
- **Link a sub-issue** (see Sub-issues below): create the child issue first, then `gh api graphql`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

Bodies go in a file, never in `--body`, and the shell reason why is in the global `AGENTS.md`. To correct a post, patch it rather than adding a second comment: `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<path>`, then read it back with `gh api repos/<owner>/<repo>/issues/comments/<id> --jq .body`.

### Documentation-only pushes

Pull requests always run CI. Pushes to `main` skip Markdown unless a tracked spec reads that file. Keep those input paths in `.github/workflows/ci.yml`; `scripts/ci/ci-push-paths.spec.ts` checks the allowlist against tracked specs.

## Naming a surface in an acceptance criterion

The issue body shape is not repeated here: `/to-issues` carries the template, and it is the single source for it. What this repo owns is what its surfaces _are_, because a criterion that names one loosely cannot be verified by reading a file.

An acceptance criterion names a surface by the path an operator or the build actually touches. "Gone from the CLI dispatcher" was not checkable in #337: `scripts/cli/cli.mjs` never dispatched those two commands. The CLI has two distinct surfaces, and a criterion should say which one it means.

- **`scripts/cli/cli.mjs`** — the `pnpm cli` dispatcher. It maps a command word to a `src/cli/*.ts` runner through `cliRunnerDescriptor` and `loadCliRunner`. Every `pnpm cli <command>` subcommand has a case here.
- **`scripts/cli/<tool>.cjs`** — a standalone entry script for a tool that is not a `pnpm cli` subcommand, loaded from `dist/cli/*.js` or the `.ts` source. Such a tool needs both its `.cjs` wrapper and a `package.json` script, and appears in neither `scripts/cli/cli.mjs` nor `knip.json` entry evidence unless something else reaches it.

Say which one: "gone from `scripts/cli/cli.mjs`" or "its `scripts/cli/<tool>.cjs` entry script is removed". When a criterion cannot be verified by reading one file, name the file.

## Closing an issue

Ask first: **does this change run in production?** A controller, an adapter, a migration, or a deployment manifest does; a test, a check script, and a doc do not. The two kinds close on different evidence, and closing on the wrong one either ships an unreleased claim or blocks a finished doc.

An issue whose change runs in production closes on evidence that it runs there, not on a green test run or a merge into a feature branch. A fix that is merged only into an unmerged branch has not reached production: `main` deploys, nothing else does.

The closing comment names:

- the commit on `main` that carries the change;
- what was observed on the host after CD finished, for example `ops/status.sh` reporting that commit as healthy, a `schema_migrations` row for a migration, or a probe of the changed behaviour.

Until then, leave the issue open and say in a comment where the fix is and what still has to happen. If an issue was closed too early, reopen it with the evidence.

A commit that is not on `origin/main` has not deployed, whatever the local checks say. `git log origin/main..HEAD --oneline` settles it before the closing comment is written.

Changes that never run in production (docs, tests, CI, tooling) close when they are merged into `main`.

Why: #261 was closed after its fix passed the database lane, while the fix sat on an unmerged feature branch. Production kept rejecting every registration until the migration was shipped to `main` separately.

## Sub-issues

**GraphQL.** The REST write endpoint returns 404 on this repo; read (`GET .../issues/<n>/sub_issues`) works. Go straight to `addSubIssue`.

```powershell
gh api graphql -f query='mutation($i:ID!,$s:ID!){addSubIssue(input:{issueId:$i,subIssueId:$s}){subIssue{number url} issue{number}}}' `
  -F i=$(gh api repos/<owner>/<repo>/issues/<parent> --jq .node_id) `
  -F s=$(gh api repos/<owner>/<repo>/issues/<child> --jq .node_id)
```

`issueId` is the **parent**, `subIssueId` the child, both `node_id`. Verify with `gh api repos/<owner>/<repo>/issues/<parent>/sub_issues --jq length`.

Two REST shapes silently do nothing: `POST /issues` with `parent_issue_number` creates an unlinked issue (`parent_url: null`), and `POST /issues/<parent>/sub_issues` 404s. Neither raises, so confirm the link after writing.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see Sub-issues above; GraphQL only). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: answer in a file, `gh issue comment <n> --body-file <path>`, then `gh issue close <n>` per [Closing an issue](#closing-an-issue), then append a context pointer (gist + link) to the map's Decisions-so-far.
