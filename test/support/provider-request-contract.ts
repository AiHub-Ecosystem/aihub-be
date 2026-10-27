import Ajv2020 from 'ajv/dist/2020';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('provider request schema has an unexpected shape');
  }
  return value as Json;
}

export function requestSchema(doc: Json, path: string, media: string): Json {
  const post = object(object(object(doc.paths)[path]).post);
  let schema = object(
    object(object(object(post.requestBody).content)[media]).schema,
  );
  while (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/'))
      throw new Error('external provider schema reference');
    let target: unknown = doc;
    for (const part of schema.$ref.slice(2).split('/')) {
      target = object(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    schema = object(target);
  }
  return schema;
}

export function requestContractFailures(
  doc: Json,
  path: string,
  media: string,
  body: Json,
): string[] {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile({
    ...requestSchema(doc, path, media),
    components: doc.components,
  });
  if (validate(body)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath}: ${error.keyword} ${error.message ?? ''}`,
  );
}
