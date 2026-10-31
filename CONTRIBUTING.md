# Contributing

Thanks for helping improve AIHUB. GitHub Issues are the source for project
specifications and work tracking.

## Before making a change

- Check for an existing issue. If the work is not tracked, follow the steps in
  [the issue tracker guide](docs/agents/issue-tracker.md) before filing one.
- Follow the setup in [README.md](README.md) and
  [the local development guide](docs/local-demo.md).
- Read [AGENTS.md](AGENTS.md) and the relevant accepted ADRs and path-scoped
  rules before changing code.

## Changes and checks

- Keep changes focused and describe behavior changes in the linked issue.
- Run `bun run check:changed` after each batch of code edits and `bun run verify`
  before handoff. Use `bun run test -- ./path/to/spec-file.spec.ts` for a focused spec.
- Use Conventional Commit headers and write commits, issues, pull requests, and
  comments in English, as described in [AGENTS.md](AGENTS.md).

## Public API compatibility

CI compares the generated OpenAPI contract with the pull request's base. Adding
a route, response field, or value to an `x-extensible-enum` is additive.
Removing or renaming a route or field, requiring a request field, narrowing
accepted request values, changing a field's meaning or type, or changing a
closed response enum is breaking. To record an intentional break, add these
lines to the pull request description:

```text
API-Breaking-Change: intentional
API-Breaking-Change-Reason: <non-empty explanation>
```

The declaration records intent for review; it does not approve the change.

## Pull requests

Open a pull request against `main`, link the issue it addresses, and summarize
the change and the checks you ran. For production changes, follow the
[issue-closing evidence](docs/agents/issue-tracker.md#closing-an-issue) process
before claiming the work has shipped.
