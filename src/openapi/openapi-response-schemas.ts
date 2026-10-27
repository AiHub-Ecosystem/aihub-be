type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function extendSchema(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) extendSchema(item);
    return;
  }
  if (!isRecord(schema)) return;

  if (schema.type === 'object' || isRecord(schema.properties)) {
    schema.additionalProperties = true;
  }

  if (isRecord(schema.properties)) {
    for (const property of Object.values(schema.properties)) {
      extendSchema(property);
    }
  }

  for (const key of [
    'items',
    'allOf',
    'anyOf',
    'oneOf',
    'additionalProperties',
    'prefixItems',
    'if',
    'then',
    'else',
  ]) {
    extendSchema(schema[key]);
  }
}

function extendResponse(response: unknown): void {
  if (!isRecord(response) || !isRecord(response.content)) return;

  for (const media of Object.values(response.content)) {
    if (isRecord(media) && media.schema !== undefined) {
      // Response and request TypeBox schemas can share references.
      media.schema = JSON.parse(JSON.stringify(media.schema)) as unknown;
      extendSchema(media.schema);
    }
  }
}

export function extendPublicResponseSchemas(document: {
  paths: Record<string, unknown>;
  components: { responses: Record<string, unknown> };
}): void {
  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isRecord(operation) || !isRecord(operation.responses)) continue;
      for (const response of Object.values(operation.responses)) {
        extendResponse(response);
      }
    }
  }

  for (const response of Object.values(document.components.responses)) {
    extendResponse(response);
  }
}
