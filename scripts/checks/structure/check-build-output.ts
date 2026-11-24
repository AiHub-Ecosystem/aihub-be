/**
 * The production artifact must not carry test support. `*.spec.ts` and a few
 * `testing/` folders are excluded by tsconfig.build.json and nest-cli.json, but
 * helpers named `.testing.ts`, `.spec-support.ts`, `.test-fixtures.ts`,
 * `.fixture-client.ts` or `test-support.ts` are still emitted unless they live
 * outside `src/`. This check asserts the artifact, not the source naming.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const TEST_SUPPORT_FILE =
  /(?:\.testing\.|\.spec-support\.|\.test-fixtures\.|\.fixture(?:-client)?\.|(?:^|[/\\])test-support)/;
const TEST_REFERENCE = /(['"])[^'"]*[/\\]test[/\\][^'"]*\1/g;

interface Violation {
  readonly file: string;
  readonly reason: string;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

if (!existsSync(dist)) {
  console.error(
    "Build output check failed: 'dist/' is absent. Run the build before the output assertion.",
  );
  process.exitCode = 1;
} else {
  const violations: Violation[] = [];
  for (const file of walk(dist)) {
    const name = relative(dist, file).replaceAll('\\', '/');
    if (TEST_SUPPORT_FILE.test(name)) {
      violations.push({ file: name, reason: 'test-support module emitted' });
      continue;
    }
    if (!file.endsWith('.js')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(TEST_REFERENCE)) {
      violations.push({
        file: name,
        reason: `reference to a test/ path: ${match[0]}`,
      });
      break;
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.reason}`);
    }
    console.error(
      `Build output check failed: ${violations.length} test-support artifact(s).`,
    );
    process.exitCode = 1;
  } else {
    console.log('Build output check passed: no test support in dist/.');
  }
}
