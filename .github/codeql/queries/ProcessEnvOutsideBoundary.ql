/**
 * @name Runtime environment read outside configuration boundaries
 * @description Application code reads process.env outside the configuration and CLI composition roots.
 * @kind problem
 * @problem.severity error
 * @precision high
 * @id aihub/process-env-outside-boundary
 * @tags maintainability
 */

import javascript

from PropAccess access
where
  access.getPropertyName() = "env" and
  access.getBase() instanceof Identifier and
  access.getBase().(Identifier).getName() = "process" and
  not access.getFile().getRelativePath().regexpMatch(".*src/(config|cli)/.*") and
  // Tooling and root config files run outside the application and have no
  // configuration module.
  not access.getFile().getRelativePath().regexpMatch("(scripts|ops|prisma|coverage)/.*|[^/]+") and
  not access.getFile().getRelativePath().regexpMatch(".*\\.spec\\.[cm]?[jt]sx?")
select access, "Read validated environment values through configuration outside src/config or src/cli."
