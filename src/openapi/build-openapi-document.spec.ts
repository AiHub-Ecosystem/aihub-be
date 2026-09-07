import { OPERATION_CATALOG } from '../catalog/operation-catalog';
import { OPERATION_IDS } from '../catalog/operation-id';
import { buildOpenApiDocument } from './build-openapi-document';

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters: readonly Record<string, unknown>[];
  readonly requestBody: {
    readonly content: Record<string, { readonly schema: unknown }>;
  };
  readonly responses: Record<string, unknown>;
  readonly 'x-required-scope': string;
  readonly 'x-identity-scope': string;
  readonly 'x-idempotency': string;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly security: readonly Record<string, readonly string[]>[];
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly parameters: Record<string, unknown>;
    readonly responses: Record<string, unknown>;
  };
  readonly paths: Record<string, { readonly post: OpenApiOperation }>;
}

function build(): OpenApiDocument {
  return buildOpenApiDocument('0.0.0-test') as OpenApiDocument;
}

describe('buildOpenApiDocument', () => {
  it('declares OpenAPI 3.1', () => {
    expect(build().openapi).toBe('3.1.0');
  });

  it('has exactly one path entry per catalogued operation, so adding an operation without regenerating fails', () => {
    const doc = build();
    const operationIds = Object.values(doc.paths).map(
      (item) => item.post.operationId,
    );

    expect(operationIds.sort()).toEqual([...OPERATION_IDS].sort());
    expect(operationIds).toHaveLength(OPERATION_IDS.length);
  });

  it('uses the exact public path the catalog declares, with no duplicated version prefix', () => {
    const doc = build();

    for (const operationId of OPERATION_IDS) {
      const catalogued = OPERATION_CATALOG[operationId];
      const pathItem = doc.paths[catalogued.path];

      expect(pathItem).toBeDefined();
      expect(pathItem?.post.operationId).toBe(operationId);
      expect(catalogued.path).toMatch(/^\/v1\//);
      expect(catalogued.path).not.toMatch(/^\/v1\/v1\//);
    }
  });

  it('embeds the exact request and response schema objects from the catalog', () => {
    const doc = build();
    const operation = doc.paths['/v1/writing/task1/grade']?.post;
    const catalogued = OPERATION_CATALOG['writing.task1.grade'];

    expect(operation?.requestBody.content['application/json']?.schema).toBe(
      catalogued.requestSchema,
    );
  });

  it('carries the required scope, identity scope, and idempotency mode as vendor extensions', () => {
    const doc = build();
    const operation = doc.paths['/v1/writing/task1/grade']?.post;

    expect(operation?.['x-required-scope']).toBe('writing.grade');
    expect(operation?.['x-identity-scope']).toBe('user');
    expect(operation?.['x-idempotency']).toBe('required');
  });

  it('documents an ignored Idempotency-Key parameter for an operation catalogued as none', () => {
    const doc = build();
    const operation = doc.paths['/v1/writing/task1/questions']?.post;
    const names = operation?.parameters.map(
      (parameter) => parameter.name ?? parameter.$ref,
    );

    expect(names).toContain('Idempotency-Key');
    expect(
      operation?.parameters.find(
        (parameter) => parameter.name === 'Idempotency-Key',
      ),
    ).toMatchObject({
      required: false,
      description: expect.stringContaining('Ignored'),
    });
  });

  it('marks Idempotency-Key required only for an operation catalogued as required', () => {
    const doc = build();
    const required = doc.paths['/v1/writing/task1/grade']?.post.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );
    const optional = doc.paths[
      '/v1/writing/task2/questions'
    ]?.post.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );

    expect(required?.required).toBe(true);
    expect(optional?.required).toBe(false);
  });

  it('references the correlation id header on every operation', () => {
    const doc = build();

    for (const operationId of OPERATION_IDS) {
      const path = OPERATION_CATALOG[operationId].path;
      const refs = doc.paths[path]?.post.parameters.map(
        (parameter) => parameter.$ref,
      );

      expect(refs).toContain('#/components/parameters/CorrelationId');
    }
  });

  it('requires a user assertion only for user-scoped operations', () => {
    const userParameters =
      build().paths['/v1/writing/task1/grade']?.post.parameters;
    const organizationParameters =
      build().paths['/v1/writing/task1/questions']?.post.parameters;

    expect(userParameters).toContainEqual({
      $ref: '#/components/parameters/UserAssertion',
    });
    expect(organizationParameters).not.toContainEqual({
      $ref: '#/components/parameters/UserAssertion',
    });
    expect(build().components.parameters.UserAssertion).toMatchObject({
      name: 'X-User-Assertion',
      in: 'header',
      required: true,
    });
  });

  it('declares the organization API key as a security scheme, not a bare header parameter', () => {
    const doc = build();

    expect(doc.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
  });

  it('documents every error code actually reachable in the current runtime', () => {
    const doc = build();
    const operation = doc.paths['/v1/writing/task1/grade']?.post;

    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      [
        '200',
        '409',
        '400',
        '401',
        '403',
        '413',
        '429',
        '500',
        '502',
        '503',
        '504',
      ].sort(),
    );
    expect(doc.components.responses.Error503).toBeDefined();
    expect(doc.components.responses.Error409).toBeDefined();
  });

  it('documents the replay marker on required idempotent success responses', () => {
    const operation = build().paths['/v1/writing/task1/grade']?.post;
    const success = operation?.responses['200'] as {
      readonly headers?: Record<string, unknown>;
    };

    expect(success.headers?.['Idempotent-Replay']).toMatchObject({
      schema: { type: 'string', enum: ['true'] },
    });
  });

  it('documents replay and conflict responses for optional idempotency', () => {
    const operation = build().paths['/v1/writing/task2/questions']?.post;
    const success = operation?.responses['200'] as {
      readonly headers?: Record<string, unknown>;
    };

    expect(success.headers?.['Idempotent-Replay']).toBeDefined();
    expect(operation?.responses['409']).toBeDefined();
  });

  it('does not advertise idempotency conflicts for operations catalogued as none', () => {
    const operation = build().paths['/v1/writing/task1/questions']?.post;

    expect(operation?.responses['409']).toBeUndefined();
  });

  it('takes the document version from the caller rather than hardcoding one', () => {
    expect(
      (buildOpenApiDocument('9.9.9') as OpenApiDocument).info.version,
    ).toBe('9.9.9');
  });
});
