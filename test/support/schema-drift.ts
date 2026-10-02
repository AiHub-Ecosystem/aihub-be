/**
 * Where AIHUB's schema for an AI service's response is narrower than the schema
 * the service publishes: places a response that obeys the provider's own
 * contract would be refused here. Only those places count:
 *
 * - `nullable`: the provider allows null and AIHUB does not.
 * - `optional`: the provider may omit a field and AIHUB requires it.
 * - `type`: the two disagree on the kind of value.
 * - `enum`: the provider may send a value AIHUB does not list.
 * - `extra-key`: the provider has a key that a closed AIHUB object rejects.
 *
 * AIHUB being looser than the provider is harmless and ignored, and so are
 * numeric and length bounds, which AIHUB is free to tighten. A top-level key
 * only the provider has is ignored too: the adapter picks the keys it maps and
 * drops the rest on purpose.
 */

export type DriftKind = 'nullable' | 'optional' | 'type' | 'enum' | 'extra-key';

export interface Drift {
  readonly kind: DriftKind;
  readonly path: string;
  readonly detail: string;
}

type Schema = Record<string, unknown>;

export interface SchemaSide {
  readonly node: unknown;
  /** The document `$ref`s resolve against. */
  readonly doc: Schema;
}

interface Shape {
  readonly kinds: readonly string[];
  readonly nullable: boolean;
  readonly values: readonly string[] | undefined;
  readonly properties: Schema;
  readonly required: ReadonlySet<string>;
  readonly closed: boolean;
  readonly items: unknown;
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(node: unknown, doc: Schema): Schema {
  let current = node;
  while (isSchema(current) && typeof current.$ref === 'string') {
    let target: unknown = doc;
    for (const part of current.$ref.replace(/^#\//, '').split('/')) {
      target = isSchema(target) ? target[part] : undefined;
    }
    current = target;
  }
  return isSchema(current) ? current : {};
}

function constants(alternatives: readonly Schema[]): string[] | undefined {
  const values: string[] = [];
  for (const alternative of alternatives) {
    if ('const' in alternative) {
      values.push(String(alternative.const));
    } else if (Array.isArray(alternative.enum)) {
      values.push(...alternative.enum.map(String));
    } else {
      return undefined;
    }
  }
  return values;
}

function shapeOf(input: unknown, doc: Schema): Shape {
  const node = resolve(input, doc);
  const alternatives = [node.anyOf, node.oneOf]
    .filter(Array.isArray)
    .flat()
    .map((alternative) => resolve(alternative, doc));
  const nonNull = alternatives.filter(
    (alternative) => alternative.type !== 'null',
  );
  const nullable = alternatives.length > nonNull.length;

  if (nonNull.length === 1 && nonNull[0] !== undefined) {
    const inner = shapeOf(nonNull[0], doc);
    return { ...inner, nullable: inner.nullable || nullable };
  }

  const types = Array.isArray(node.type)
    ? node.type.map(String)
    : [node.type].filter((t) => typeof t === 'string').map(String);
  const values =
    nonNull.length > 1
      ? constants(nonNull)
      : Array.isArray(node.enum)
        ? node.enum.map(String)
        : 'const' in node
          ? [String(node.const)]
          : undefined;

  return {
    kinds: types.filter((type) => type !== 'null'),
    nullable: nullable || types.includes('null'),
    values: values === undefined ? undefined : [...values].sort(),
    properties: isSchema(node.properties) ? node.properties : {},
    required: new Set(
      Array.isArray(node.required) ? node.required.map(String) : [],
    ),
    closed: node.additionalProperties === false,
    items: node.items,
  };
}

function walk(
  path: string,
  provider: SchemaSide,
  ours: SchemaSide,
  atRoot: boolean,
  found: Drift[],
): void {
  const theirs = shapeOf(provider.node, provider.doc);
  const mine = shapeOf(ours.node, ours.doc);

  if (
    theirs.kinds.length > 0 &&
    mine.kinds.length > 0 &&
    theirs.kinds.join() !== mine.kinds.join()
  ) {
    found.push({
      kind: 'type',
      path,
      detail: `provider ${theirs.kinds.join('|')}, AIHUB ${mine.kinds.join('|')}`,
    });
  }
  if (theirs.nullable && !mine.nullable) {
    found.push({
      kind: 'nullable',
      path,
      detail: 'provider allows null, AIHUB does not',
    });
  }
  if (theirs.values !== undefined && mine.values !== undefined) {
    const missing = theirs.values.filter(
      (value) => !mine.values?.includes(value),
    );
    if (missing.length > 0) {
      found.push({
        kind: 'enum',
        path,
        detail: `provider may send ${missing.join(', ')}`,
      });
    }
  }

  for (const key of Object.keys(theirs.properties)) {
    const child = `${path}.${key}`;
    if (!(key in mine.properties)) {
      if (mine.closed && !atRoot) {
        found.push({
          kind: 'extra-key',
          path: child,
          detail: 'provider has a key a closed AIHUB object rejects',
        });
      }
      continue;
    }
    if (!theirs.required.has(key) && mine.required.has(key)) {
      found.push({
        kind: 'optional',
        path: child,
        detail: 'provider may omit it, AIHUB requires it',
      });
    }
    walk(
      child,
      { node: theirs.properties[key], doc: provider.doc },
      { node: mine.properties[key], doc: ours.doc },
      false,
      found,
    );
  }

  if (isSchema(theirs.items) && isSchema(mine.items)) {
    walk(
      `${path}[]`,
      { node: theirs.items, doc: provider.doc },
      { node: mine.items, doc: ours.doc },
      false,
      found,
    );
  }
}

/** `provider` is the service's own schema for the response body, `ours` AIHUB's. */
export function schemaDrift(provider: SchemaSide, ours: SchemaSide): Drift[] {
  const found: Drift[] = [];
  walk('data', provider, ours, true, found);
  return found.sort(
    (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
  );
}
