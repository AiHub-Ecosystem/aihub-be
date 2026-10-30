import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

// A customer builds retry handling from the guide's list of refusals that
// carry `retry_after_ms`. The source is what decides which codes do: a code
// that gains the hint (#936 found `DATABASE_UNAVAILABLE`, the storage outages,
// `AUTH_ARGON2_CAPACITY` and others missing from the list) must be listed, and
// a listed code that no longer carries it must go.
const SRC = join(__dirname, '..');
const GUIDE = readFileSync(join(SRC, '../docs/integration-guide.md'), 'utf8');

// These build an error from a code a caller passes in, so the code to read is
// at the call site, which this scan reaches on its own.
const CARRIERS = [
  'common/errors/app-error.ts',
  'common/errors/error-envelope.ts',
  'modules/gateway/infrastructure/http-operation-dispatcher.ts',
];

const ERROR_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') &&
      !path.endsWith('.spec.ts') &&
      !path.endsWith('.spec-support.ts')
      ? [path]
      : [];
  });
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  return property.name?.getText() ?? '';
}

function carriesHint(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some((property) =>
    ts.isSpreadAssignment(property)
      ? property.getText().includes('retryAfterMs')
      : propertyName(property) === 'retryAfterMs',
  );
}

/** The error codes a function's parameter types name, for `code` passed through. */
function codesNamedByParameters(node: ts.Node): string[] {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (!ts.isFunctionLike(at)) continue;
    const codes: string[] = [];
    for (const parameter of at.parameters) {
      const visit = (child: ts.Node): void => {
        if (ts.isStringLiteral(child) && ERROR_CODE.test(child.text)) {
          codes.push(child.text);
        }
        ts.forEachChild(child, visit);
      };
      visit(parameter);
    }
    return codes;
  }
  return [];
}

function sourceHintCodes(): { codes: Set<string>; unresolved: string[] } {
  const codes = new Set<string>();
  const unresolved: string[] = [];

  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('retryAfterMs')) continue;
    const file = relative(SRC, path).split(sep).join('/');
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && carriesHint(node)) {
        const code = node.properties.find(
          (property) => propertyName(property) === 'code',
        );
        const value =
          code === undefined
            ? undefined
            : ts.isPropertyAssignment(code)
              ? code.initializer
              : ts.isShorthandPropertyAssignment(code)
                ? code.name
                : code;
        if (value !== undefined && ts.isStringLiteral(value)) {
          codes.add(value.text);
        } else if (value !== undefined && !CARRIERS.includes(file)) {
          const named = codesNamedByParameters(node);
          if (named.length === 0) {
            unresolved.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            );
          }
          named.forEach((name) => codes.add(name));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { codes, unresolved };
}

/** The codes in the first column of the guide's list of refusals with a hint. */
function documentedHintCodes(): Set<string> {
  const lines = GUIDE.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| Refusal '));
  if (start === -1) {
    throw new Error('integration guide has no retry_after_ms refusal table');
  }
  const codes = new Set<string>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const firstCell = line.split('|')[1] ?? '';
    for (const [, code] of firstCell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      if (code !== undefined) codes.add(code);
    }
  }
  return codes;
}

describe('integration guide retry hints', () => {
  const { codes: carrying, unresolved } = sourceHintCodes();

  it('reads every place the source sets a hint on a known code', () => {
    expect(unresolved).toEqual([]);
    expect(carrying.size).toBeGreaterThan(10);
  });

  it('lists every code that can carry retry_after_ms', () => {
    const documented = documentedHintCodes();

    expect(
      [...carrying].filter((code) => !documented.has(code)).sort(),
    ).toEqual([]);
  });

  it('lists no code that cannot carry retry_after_ms', () => {
    const documented = documentedHintCodes();

    expect(
      [...documented].filter((code) => !carrying.has(code)).sort(),
    ).toEqual([]);
  });
});
