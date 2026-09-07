# Review a change

Review the diff against the canonical spec, then check:

- dependency direction and module ownership;
- tenant identity and scope propagation;
- secret/raw-body redaction;
- distinct Task1/Task2 contracts;
- tests for every new behavior and boundary;
- `pnpm type-check`, `pnpm arch-check`, and `pnpm verify` evidence.

Report blockers with the exact file and rule. Do not rewrite the entire specification into the review.
