import { buildOpenApiDocument } from './build-openapi-document';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function collectObjectSchemas(
  value: unknown,
  found: JsonRecord[] = [],
): JsonRecord[] {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectSchemas(item, found);
    return found;
  }
  if (!isRecord(value)) return found;

  if (value.type === 'object' || isRecord(value.properties)) found.push(value);

  for (const key of [
    'properties',
    'items',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'additionalProperties',
    'prefixItems',
    'if',
    'then',
    'else',
  ]) {
    collectObjectSchemas(value[key], found);
  }
  return found;
}

function responseSchemas(document: JsonRecord): unknown[] {
  const schemas: unknown[] = [];
  const paths = document.paths;
  if (isRecord(paths)) {
    for (const pathItem of Object.values(paths)) {
      if (!isRecord(pathItem)) continue;
      for (const operation of Object.values(pathItem)) {
        if (!isRecord(operation) || !isRecord(operation.responses)) continue;
        for (const response of Object.values(operation.responses)) {
          if (!isRecord(response) || !isRecord(response.content)) continue;
          for (const media of Object.values(response.content)) {
            if (isRecord(media)) schemas.push(media.schema);
          }
        }
      }
    }
  }

  const components = document.components;
  if (isRecord(components) && isRecord(components.responses)) {
    for (const response of Object.values(components.responses)) {
      if (!isRecord(response) || !isRecord(response.content)) continue;
      for (const media of Object.values(response.content)) {
        if (isRecord(media)) schemas.push(media.schema);
      }
    }
  }
  return schemas;
}

describe('public OpenAPI object schema policy', () => {
  const document = buildOpenApiDocument('1.0.0') as JsonRecord;

  it('allows additional properties at every response object boundary', () => {
    const objects = responseSchemas(document).flatMap((schema) =>
      collectObjectSchemas(schema),
    );

    expect(objects.length).toBeGreaterThan(0);
    expect(
      objects.every((schema) => schema.additionalProperties === true),
    ).toBe(true);
  });

  it('keeps request object schemas closed', () => {
    const objects: JsonRecord[] = [];
    const paths = document.paths;
    if (!isRecord(paths)) throw new Error('OpenAPI paths are missing');

    for (const pathItem of Object.values(paths)) {
      if (!isRecord(pathItem)) continue;
      for (const operation of Object.values(pathItem)) {
        if (!isRecord(operation) || !isRecord(operation.requestBody)) continue;
        const content = operation.requestBody.content;
        if (!isRecord(content)) continue;
        for (const media of Object.values(content)) {
          if (isRecord(media)) collectObjectSchemas(media.schema, objects);
        }
      }
    }

    expect(objects.length).toBeGreaterThan(0);
    expect(
      objects
        .filter((schema) => schema.type === 'object')
        .every((schema) => schema.additionalProperties === false),
    ).toBe(true);
  });
});
