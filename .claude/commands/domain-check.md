# Check architecture boundaries

Run `pnpm arch-check` from the repository root. If it fails, fix the dependency direction at the owning boundary instead of suppressing the rule. Then run the focused tests for the changed layer.
