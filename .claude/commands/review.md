# Review a change

Review the diff against the canonical spec, then check:

- dependency direction and module ownership;
- tenant identity and scope propagation;
- secret/raw-body redaction;
- distinct Task1/Task2 contracts;
- tests for every new behavior and boundary;
- a change to an enforcement mechanism (a check script, lint configuration, or CI gate) updates the Enforcement section or status note of the ADR that the mechanism implements;
- `pnpm type-check`, `pnpm arch-check`, and `pnpm verify` evidence.

Report blockers with the exact file and rule. Do not rewrite the entire specification into the review.
