import { TestingLogger } from '@nestjs/testing/services/testing-logger.service';

// Tests that provoke an error on purpose (a metering write that fails, a
// downstream that answers 502, a contract violation) make Nest print ERROR
// lines that look like real failures: about 70 lines and 50 KB per
// `pnpm verify`, which land in the terminal and in an agent's context for no
// information.
//
// Nest re-applies a `TestingLogger` on every `Test.createTestingModule()
// .compile()`, and that logger prints errors, so silencing it once here beats
// overriding the logger in each spec. A spec that asserts on logging spies on
// the logger or installs its own, and is unaffected.
//
// Set AIHUB_TEST_LOGS=1 to see the lines while debugging a failing spec.
if (process.env.AIHUB_TEST_LOGS !== '1') {
  TestingLogger.prototype.error = (): void => undefined;
}
