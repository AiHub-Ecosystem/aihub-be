# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Check what an ADR says about the world

An ADR's statements about an external system (a host, a bucket, a vendor's behaviour) are claims as of its date, and nothing re-checks them. Before a spec or another ADR builds on one, check the system itself, or record the claim as unverified. ADR-0060 said a public bucket needs a change to the host's `s3.json`; it does not, and three later documents had repeated it.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Release compatibility

Expand-only migrations preserve the schema shape across adjacent releases; they do not make new persisted values, runtime configuration, or Vault template keys compatible with N-1.

- Ship a new persisted enum/value in two releases. Release N-1 first learns to read or safely skip the value without writing it; a later release starts writing it only after that reader is deployed.
- Add environment variables and Vault template keys without renaming or removing existing keys in the same release. Remove an old key only in a later release after no deployed image reads it. Where a strict Vault bundle reader rejects an added key, follow the coordinated cutover and rollback sequence in `docs/operations/deploy-vps.md` and the applicable ADR.
- For every PR that changes persisted values or runtime configuration, name the old-reader behavior and the release that starts writing/removing the value or key. Keep unknown-value telemetry bounded and free of payloads or secret values.
