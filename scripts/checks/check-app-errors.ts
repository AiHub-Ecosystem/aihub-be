import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';

const ROOT = process.cwd();
const INLINE_ALLOW_MARKER = /\/\/ app-error-check: allow .+/u;

const FILE_ALLOWLIST = new Map([
  [
    'src/openapi/openapi-local-auth-path-items.ts',
    'OpenAPI document builder validation',
  ],
  ['src/openapi/openapi-shared.ts', 'OpenAPI document builder validation'],
  [
    'src/postman/build-postman-collection.ts',
    'Postman collection builder validation',
  ],
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  const files: string[][] = await Promise.all(
    entries.map(async (entry: Dirent): Promise<string[]> => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.spec-support.ts') &&
        !entryPath.split(path.sep).includes('testing')
      ) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat();
}

function isRawErrorConstruction(node: ts.Node): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Error'
  );
}

function hasInlineAllowMarker(sourceText: string, node: ts.Node): boolean {
  const comments = [
    ...(ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(sourceText, node.end) ?? []),
    ...(node.parent === undefined
      ? []
      : (ts.getTrailingCommentRanges(sourceText, node.parent.end) ?? [])),
  ];
  return comments.some(({ pos, end }) =>
    INLINE_ALLOW_MARKER.test(sourceText.slice(pos, end)),
  );
}

export async function findViolations(root: string = ROOT): Promise<string[]> {
  const files = await sourceFiles(path.join(root, 'src'));
  const violations: string[] = [];

  for (const absolutePath of files) {
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join('/');
    if (FILE_ALLOWLIST.has(relativePath)) continue;

    const sourceText = await readFile(absolutePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      if (isRawErrorConstruction(node)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (!hasInlineAllowMarker(sourceText, node)) {
          violations.push(`${relativePath}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return violations.sort((left, right) => left.localeCompare(right));
}

async function main(): Promise<void> {
  const violations = await findViolations();
  if (violations.length > 0) {
    console.error(
      [
        'Raw `new Error(...)` is not allowed in runtime source. Use AppError.',
        ...violations.map((violation) => `  ${violation}`),
      ].join('\n'),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.join(ROOT, 'scripts/checks/check-app-errors.ts')
) {
  void main();
}
