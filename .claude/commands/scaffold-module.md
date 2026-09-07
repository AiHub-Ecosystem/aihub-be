# Scaffold a module

Use when a user asks for a new AIHUB module with an externally observable behavior.

1. Read the relevant implementation spec and `CONTEXT.md`.
2. Confirm the module belongs in the current MVP and has a first behavior to test.
3. Write the domain or application test first and verify RED.
4. Create only the layers that contain behavior under `src/modules/`.
5. Add application ports before concrete infrastructure and keep module wiring in the module file.
6. Register the module in `src/app.module.ts`, run focused tests, type-check, and architecture checks.
7. Do not create empty Speaking/Reading, billing, or async modules.
