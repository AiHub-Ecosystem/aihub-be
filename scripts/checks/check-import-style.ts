/**
 * ADR-0067: a parent-relative import whose resolved target lies under `src/` is
 * an error. `paths` maps `@/*` to `src/*`, so the alias is the only spelling that
 * reaches application code from anywhere. A sibling import stays relative, and a
 * parent-relative import resolving outside `src/` is legal.
 *
 * Only import positions are read. A filesystem path assembled from `__dirname`
 * and a comment that quotes a path are both correct as written and must not be
 * rewritten or reported.
 *
 * Run `pnpm check:imports` for the source form, `pnpm check:imports:dist` for
 * the emitted output. They are separate commands because the two are separate
 * jobs in CI: the build and the architecture check do not share a job, so the
 * output assertion cannot be skipped silently inside the source check.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import ts from 'typescript';

interface Violation {
  file: string;
  line: number;
  specifier: string;
}

const SOURCE_TREES = ['src', 'test', 'scripts'] as const;
const ALIAS_IN_OUTPUT = /(['"])@\/([^'"]*)\1/g;

/**
 * A specifier reaches a parent directory when any segment is `..`, which is not
 * the same as starting with `../`: `./../x` and a bare `..` both do, and both
 * resolve into `src/` from a file inside it.
 */
function reachesParent(specifier: string): boolean {
  return specifier.split(/[\\/]/).includes('..');
}

function collectFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(path, extension));
    } else if (path.endsWith(extension) && !path.endsWith('.d.ts')) {
      files.push(path);
    }
  }

  return files;
}

function importSpecifiers(source: ts.SourceFile): ts.StringLiteral[] {
  const found: ts.StringLiteral[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const { moduleSpecifier } = node;

      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        found.push(moduleSpecifier);
      }
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;

      if (
        (isRequire || isDynamicImport) &&
        argument &&
        ts.isStringLiteral(argument)
      ) {
        found.push(argument);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function resolvesUnder(
  file: string,
  specifier: string,
  srcRoot: string,
): boolean {
  const target = resolve(dirname(file), specifier);

  return target === srcRoot || target.startsWith(srcRoot + sep);
}

export function collectViolations(file: string, srcRoot: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  return importSpecifiers(source)
    .filter(
      (specifier) =>
        reachesParent(specifier.text) &&
        resolvesUnder(file, specifier.text, srcRoot),
    )
    .map((specifier) => ({
      file,
      line: lineOf(source, specifier),
      specifier: specifier.text,
    }));
}

export function collectSourceViolations(root: string): Violation[] {
  const srcRoot = join(root, 'src');

  return SOURCE_TREES.flatMap((tree) =>
    collectFiles(join(root, tree), '.ts').flatMap((file) =>
      collectViolations(file, srcRoot),
    ),
  ).sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export function collectDistViolations(distDirectory: string): Violation[] {
  return collectFiles(distDirectory, '.js').flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((text, index) => {
        const violations: Violation[] = [];

        for (const match of text.matchAll(ALIAS_IN_OUTPUT)) {
          violations.push({
            file,
            line: index + 1,
            specifier: `@/${match[2]}`,
          });
        }

        return violations;
      }),
  );
}

function report(violations: Violation[], remedy: string): void {
  if (violations.length === 0) {
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: ${remedy} ('${violation.specifier}')`,
    );
  }

  console.error(`Import style check failed: ${violations.length} import(s).`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-import-style.ts')) {
  const root = process.cwd();

  if (process.argv.includes('--dist')) {
    const dist = join(root, 'dist');

    if (existsSync(dist)) {
      report(
        collectDistViolations(dist),
        'an alias specifier must not survive into the build output; the transform has to rewrite it to a relative path',
      );
    } else {
      console.error(
        "Import style check failed: 'dist/' is absent. Run the build before the output assertion.",
      );
      process.exitCode = 1;
    }
  } else {
    report(collectSourceViolations(root), "use the '@/…' alias");
  }
}
