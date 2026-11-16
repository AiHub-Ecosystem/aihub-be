import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  array,
  constant,
  dictionary,
  integer,
  jsonValue,
  oneof,
  property,
  string,
} from 'fast-check';

import { AppError } from '@/common/errors/app-error';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { parseRequestQuery } from '@/common/http/parse-request-query';

import { assertWithReproducer } from './assert-with-reproducer';
import seeds from './seeds.json';

const CONTRACT_ROOT = resolve(process.cwd(), 'src/contracts');
const schemaModules: string[] = readdirSync(CONTRACT_ROOT, {
  recursive: true,
}).filter(
  (file): file is string =>
    typeof file === 'string' &&
    file.endsWith('.ts') &&
    !file.endsWith('.spec.ts'),
);

let publicSchemas: { name: string; schema: TSchema; query: boolean }[] = [];

async function discoverPublicSchemas(): Promise<void> {
  publicSchemas = (
    await Promise.all(
      schemaModules.map(async (file) => {
        const module = require(join(CONTRACT_ROOT, file)) as Record<
          string,
          unknown
        >;
        return Object.entries(module)
          .filter(
            ([name, schema]) =>
              /(?:Request|Query)Schema$/.test(name) &&
              name !== 'SpeakingGradeRequestSchema' &&
              typeof schema === 'object' &&
              schema !== null &&
              'type' in schema,
          )
          .map(([name, schema]) => ({
            name,
            schema: schema as TSchema,
            query: name.endsWith('QuerySchema'),
          }));
      }),
    )
  ).flat();
}

const generatedJsonValue = jsonValue({ maxDepth: 8 });
const nearMiss = oneof(
  generatedJsonValue,
  constant(null),
  array(generatedJsonValue, { maxLength: 4 }),
  dictionary(string({ maxLength: 24 }), generatedJsonValue, { maxKeys: 5 }),
  string({ maxLength: 2_100 }),
  constant('\u0000'),
  constant(JSON.parse('"\\ud800"') as string),
  constant({ unexpected_caller_field: 'caller-generated-value-626' }),
  constant({ nested: { nested: { nested: { nested: { nested: {} } } } } }),
  integer({ min: -2_147_483_649, max: 2_147_483_648 }),
);

function candidateFor(schema: TSchema): unknown {
  const shape = schema as TSchema & Record<string, unknown>;
  if ('default' in shape) return shape['default'] as unknown;
  if ('const' in shape) return shape['const'] as unknown;
  if (Array.isArray(shape['enum'])) return shape['enum'][0] as unknown;
  const choices: unknown = shape['anyOf'] ?? shape['oneOf'] ?? shape['allOf'];
  if (Array.isArray(choices)) return candidateFor(choices[0] as TSchema);
  switch (shape['type']) {
    case 'object': {
      const properties = shape['properties'] as
        | Record<string, TSchema>
        | undefined;
      const required = new Set(
        Array.isArray(shape['required']) ? shape['required'] : [],
      );
      return Object.fromEntries(
        Object.entries(properties ?? {})
          .filter(
            ([name, property]) => required.has(name) || 'default' in property,
          )
          .map(([name, property]) => [name, candidateFor(property)]),
      );
    }
    case 'array':
      return Array.from({ length: Number(shape['minItems'] ?? 0) }, () =>
        candidateFor(shape['items'] as TSchema),
      );
    case 'string': {
      const format: unknown = shape['format'];
      if (format === 'uri') return 'https://example.com';
      if (format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (format === 'email') return 'a@example.com';
      const pattern: unknown = shape['pattern'];
      if (typeof pattern === 'string' && pattern.includes('1-9')) return '1';
      return 'x'.repeat(Number(shape['minLength'] ?? 1));
    }
    case 'integer':
    case 'number':
      return shape['minimum'] ?? shape['exclusiveMinimum'] ?? 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return {};
  }
}

function stringBoundaries(schema: TSchema, base: unknown): unknown[] {
  const found: { path: string[]; min: number; max: number }[] = [];
  const visit = (node: Record<string, unknown>, path: string[]): void => {
    if (node['type'] === 'string') {
      found.push({
        path,
        min: Number(node['minLength'] ?? 0),
        max: Number(node['maxLength'] ?? node['minLength'] ?? 0),
      });
      return;
    }
    if (
      node['type'] === 'object' &&
      typeof node['properties'] === 'object' &&
      node['properties'] !== null
    ) {
      for (const [name, propertySchema] of Object.entries(node['properties'])) {
        visit(propertySchema as Record<string, unknown>, [...path, name]);
      }
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key])) {
        for (const branch of node[key] as Record<string, unknown>[])
          visit(branch, path);
      }
    }
  };
  visit(schema as Record<string, unknown>, []);
  return found.flatMap(({ path, min, max }) =>
    [min, max, max + 1].map((length) => {
      const copy = structuredClone(base) as Record<string, unknown>;
      let target = copy;
      for (const part of path.slice(0, -1))
        target = target[part] as Record<string, unknown>;
      if (path.length > 0) target[path[path.length - 1]!] = 'x'.repeat(length);
      return copy;
    }),
  );
}

function checkBoundary(schema: TSchema, query: boolean, candidate: unknown) {
  try {
    const parsed = query
      ? parseRequestQuery(schema, candidate)
      : parseRequestBody(schema, candidate);
    let parseSucceeded = true;
    try {
      Value.Parse(schema, candidate);
    } catch {
      parseSucceeded = false;
    }
    return {
      accepted: true,
      schemaValid: Value.Check(schema, parsed),
      parseSucceeded,
    };
  } catch (error) {
    const message =
      error instanceof AppError ? (error.publicMessage ?? error.message) : '';
    const callerStrings =
      typeof candidate === 'object' && candidate !== null
        ? Object.entries(candidate).flatMap(([key, value]) => [
            key,
            ...(typeof value === 'string' ? [value] : []),
          ])
        : typeof candidate === 'string'
          ? [candidate]
          : [];
    return {
      accepted: false,
      isAppError: error instanceof AppError,
      code: error instanceof AppError ? error.code : undefined,
      noReflection: callerStrings
        .filter((value) => value.length >= 8)
        .every((value) => !message.includes(value)),
    };
  }
}

describe('public request schema fuzz (#626)', () => {
  beforeAll(discoverPublicSchemas);

  it('discovers and fuzzes every exported request and query schema', async () => {
    const startedAt = performance.now();
    expect(publicSchemas.length).toBeGreaterThan(0);
    expect(new Set(publicSchemas.map(({ name }) => name)).size).toBe(
      publicSchemas.length,
    );
    for (const { name, schema, query } of publicSchemas) {
      const validCandidate = candidateFor(schema);
      const seedInputs = Value.Check(schema, validCandidate)
        ? [validCandidate, ...stringBoundaries(schema, validCandidate)]
        : [];
      const generatedInputs = oneof(
        ...seedInputs.map((value) => constant(value)),
        nearMiss,
      );
      await assertWithReproducer(
        property(generatedInputs, (candidate) => {
          const result = checkBoundary(schema, query, candidate);
          expect(
            result.accepted
              ? [true, result.schemaValid, result.parseSucceeded]
              : [false, result.isAppError, result.code, result.noReflection],
          ).toEqual(
            result.accepted
              ? [true, true, true]
              : [false, true, 'INVALID_REQUEST', true],
          );
        }),
        seeds.contracts,
        `contracts-${name}.json`,
      );
    }
    expect(performance.now() - startedAt).toBeLessThan(seeds.maxRuntimeMs);
  });
});
