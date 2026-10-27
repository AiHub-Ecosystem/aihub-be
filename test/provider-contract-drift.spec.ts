import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SpeakingGradeResponseSchema } from '@/contracts/speaking/grading';
import { parseSpeakingGradeResponse } from '@/downstream/speaking/speaking-grading-response.adapter';

import { schemaDrift } from './support/schema-drift';

// What AI Speaking publishes about its grading response, compared with the
// schema AIHUB checks that response against. AIHUB's schema was built from one
// captured response, so it can refuse a response the provider's own contract
// allows, and a refused response is a 502 AI_SERVICE_CONTRACT_VIOLATION for the
// customer. This holds every such place in view: a new one fails the test, and
// an entry that no longer applies fails it too, so the list cannot rot.
//
// Refresh the snapshot with `pnpm provider:refresh`; a weekly workflow does it
// and fails when the provider's contract has moved.

type Json = Record<string, unknown>;

interface Allowed {
  readonly kind: string;
  readonly path: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedList(value: unknown): value is Allowed[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.kind === 'string' &&
        typeof entry.path === 'string' &&
        typeof entry.reason === 'string',
    )
  );
}

function readJson<T>(
  relative: string,
  isExpected: (value: unknown) => value is T,
): T {
  const value: unknown = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', relative), 'utf8'),
  );
  if (!isExpected(value)) {
    throw new Error(`provider snapshot ${relative} has an unexpected shape`);
  }
  return value;
}

function dig(node: unknown, path: readonly string[]): unknown {
  let current = node;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`snapshot has no ${path.join('.')}`);
    }
    current = (current as Json)[part];
  }
  return current;
}

describe.each([
  ['speaking.grading', '/api/v1/speaking/grading'],
  ['speaking.grading-json', '/api/v1/speaking/grading-json'],
])(
  'AI Speaking %s: provider contract against the schema AIHUB checks',
  (_operation, path) => {
    const doc = readJson<Json>(
      'ai-speaking/provider-openapi.snapshot.json',
      isRecord,
    );
    const allowed = readJson<Allowed[]>(
      'ai-speaking/provider-drift.allowed.json',
      isAllowedList,
    );

    const responseSchema = dig(doc, [
      'paths',
      path,
      'post',
      'responses',
      '200',
      'content',
      'application/json',
      'schema',
    ]);
    const providerEnvelope = resolveRef(responseSchema, doc);
    const envelopeProperties = providerEnvelope.properties as Json;
    const providerUsage = resolveRef(envelopeProperties.usage, doc);
    const providerMetrics = resolveRef(envelopeProperties.metrics, doc);
    // The provider wraps the result as `{ status, data }`; AIHUB's schema is the
    // `data` object, which the adapter unwraps first.
    const providerData = {
      node: envelopeProperties.data,
      doc,
    };
    const oursNode: unknown = JSON.parse(
      JSON.stringify(SpeakingGradeResponseSchema),
    );
    const ours = {
      node: oursNode,
      doc: {},
    };

    const found = schemaDrift(providerData, ours);
    const key = (entry: { kind: string; path: string }) =>
      `${entry.kind} ${entry.path}`;

    it('publishes root-level usage counts and AI processing time', () => {
      expect(providerEnvelope.required).toEqual(
        expect.arrayContaining(['data', 'usage', 'metrics']),
      );
      expect(envelopeProperties.status).toMatchObject({
        type: 'string',
        default: 'success',
      });

      const usageProperties = providerUsage.properties as Json;
      expect(providerUsage.required).toEqual(
        expect.arrayContaining([
          'input_tokens',
          'output_tokens',
          'total_tokens',
        ]),
      );
      for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
        const property = usageProperties[field];
        if (!isRecord(property) || !Array.isArray(property.anyOf)) {
          throw new Error(`${field} has no nullable type list`);
        }
        expect(property.anyOf).toEqual(
          expect.arrayContaining([{ type: 'integer' }, { type: 'null' }]),
        );
      }

      expect(providerMetrics.required).toContain('ai_processing_ms');
      expect(
        (providerMetrics.properties as Json).ai_processing_ms,
      ).toMatchObject({ type: 'integer' });
    });

    it('has no difference that is not on the allowed list', () => {
      const known = new Set(allowed.map(key));

      const unexpected = found
        .filter((entry) => !known.has(key(entry)))
        .map((entry) => `${key(entry)}: ${entry.detail}`);

      expect(unexpected).toEqual([]);
    });

    it('lists nothing that no longer differs', () => {
      const current = new Set(found.map(key));

      expect(allowed.map(key).filter((entry) => !current.has(entry))).toEqual(
        [],
      );
    });

    it('gives every allowed difference a reason', () => {
      expect(
        allowed.filter((entry) => entry.reason.trim().length < 20),
      ).toEqual([]);
    });
  },
);

it('reports a JSON-only response change against the JSON operation', () => {
  const document = readJson<Json>(
    'ai-speaking/provider-openapi.snapshot.json',
    isRecord,
  );
  const components = dig(document, ['components', 'schemas']) as Json;
  const jsonResponse = dig(document, [
    'paths',
    '/api/v1/speaking/grading-json',
    'post',
    'responses',
    '200',
    'content',
    'application/json',
    'schema',
  ]) as Json;
  const envelope = structuredClone(resolveRef(jsonResponse, document));
  const data = structuredClone(
    resolveRef((envelope.properties as Json).data, document),
  );
  const feedback = structuredClone(
    resolveRef((data.properties as Json).feedback, document),
  );
  (feedback.properties as Json).summary_vi = { type: 'integer' };
  (data.properties as Json).feedback = {
    $ref: '#/components/schemas/JsonOnlyFeedback',
  };
  (envelope.properties as Json).data = {
    $ref: '#/components/schemas/JsonOnlyData',
  };
  components.JsonOnlyFeedback = feedback;
  components.JsonOnlyData = data;
  components.JsonOnlyEnvelope = envelope;
  jsonResponse.$ref = '#/components/schemas/JsonOnlyEnvelope';
  const allowed = readJson<Allowed[]>(
    'ai-speaking/provider-drift.allowed.json',
    isAllowedList,
  );
  const known = new Set(allowed.map((entry) => `${entry.kind} ${entry.path}`));
  const differences = [
    '/api/v1/speaking/grading',
    '/api/v1/speaking/grading-json',
  ].flatMap((path) => {
    const schema = dig(document, [
      'paths',
      path,
      'post',
      'responses',
      '200',
      'content',
      'application/json',
      'schema',
    ]);
    const provider = resolveRef(schema, document);
    return schemaDrift(
      { node: (provider.properties as Json).data, doc: document },
      {
        node: JSON.parse(JSON.stringify(SpeakingGradeResponseSchema)),
        doc: {},
      },
    )
      .filter((entry) => !known.has(`${entry.kind} ${entry.path}`))
      .map((entry) => `${path} ${entry.kind} ${entry.path}`);
  });
  expect(differences).toEqual([
    '/api/v1/speaking/grading-json type data.feedback.summary_vi',
  ]);
});

// A provider that stops declaring a field AIHUB requires must show up as a new
// difference, because the adapter refuses the response that follows (#1180).
describe('AI Speaking: a field the provider stops declaring', () => {
  const allowed = readJson<Allowed[]>(
    'ai-speaking/provider-drift.allowed.json',
    isAllowedList,
  );
  const known = new Set(allowed.map((entry) => `${entry.kind} ${entry.path}`));

  function component(document: Json, name: string): Json {
    return dig(document, ['components', 'schemas', name]) as Json;
  }

  function withoutField(schema: Json, field: string): void {
    delete (schema.properties as Json)[field];
    schema.required = (schema.required as string[]).filter(
      (name) => name !== field,
    );
  }

  function newDifferences(document: Json): string[] {
    return schemaDrift(
      {
        node: dig(document, ['components', 'schemas', 'PartnerAssessData']),
        doc: document,
      },
      {
        node: JSON.parse(JSON.stringify(SpeakingGradeResponseSchema)),
        doc: {},
      },
    )
      .map((entry) => `${entry.kind} ${entry.path}`)
      .filter((entry) => !known.has(entry));
  }

  function refusal(mutate: (data: Json) => void): unknown {
    const body = readJson<Json>('ai-speaking/grading.response.json', isRecord);
    mutate(body.data as Json);
    try {
      parseSpeakingGradeResponse(body);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it.each([
    {
      field: 'data.feedback',
      schema: 'PartnerAssessData',
      key: 'feedback',
      mutate: (data: Json) => {
        delete data.feedback;
      },
    },
    {
      field: 'data.feedback.summary_vi',
      schema: 'FeedbackInfo',
      key: 'summary_vi',
      mutate: (data: Json) => {
        delete (data.feedback as Json).summary_vi;
      },
    },
  ])(
    '$field is a new difference and the adapter refuses the response',
    ({ field, schema, key, mutate }) => {
      const document = readJson<Json>(
        'ai-speaking/provider-openapi.snapshot.json',
        isRecord,
      );
      withoutField(component(document, schema), key);

      expect(newDifferences(document)).toEqual([`optional ${field}`]);
      expect(refusal(mutate)).toMatchObject({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
      });
    },
  );
});

function resolveRef(node: unknown, document: Json): Json {
  let current = node as Json;
  while (typeof current.$ref === 'string') {
    current = dig(
      document,
      current.$ref.replace(/^#\//, '').split('/'),
    ) as Json;
  }
  return current;
}
