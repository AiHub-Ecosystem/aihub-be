# Skill: New AIHUB module

Use when a module has a real first behavior.

1. Read the relevant spec and write the first behavior test.
2. Add only meaningful `domain`, `application`, `infrastructure`, and `presentation` directories.
3. Keep ports in application and concrete adapters in infrastructure.
4. Register providers in the module composition root.
5. Test the behavior and run architecture checks.

Do not scaffold empty Speaking, Reading, billing, or async modules.
