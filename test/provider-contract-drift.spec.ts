import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SpeakingGradeResponseSchema } from '@/contracts/speaking/grading';

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

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', relative), 'utf8'),
  );
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

describe('AI Speaking: provider contract against the schema AIHUB checks', () => {
  const doc = readJson<Json>('ai-speaking/provider-openapi.snapshot.json');
  const allowed = readJson<Allowed[]>(
    'ai-speaking/provider-drift.allowed.json',
  );

  const responseSchema = dig(doc, [
    'paths',
    '/api/v1/speaking/grading',
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
  const ours = {
    node: JSON.parse(JSON.stringify(SpeakingGradeResponseSchema)),
    doc: {},
  };

  const found = schemaDrift(providerData, ours);
  const key = (entry: { kind: string; path: string }) =>
    `${entry.kind} ${entry.path}`;

  it('publishes root-level usage counts and AI processing time', () => {
    expect(providerEnvelope.required).toEqual(
      expect.arrayContaining(['usage', 'metrics']),
    );

    const usageProperties = providerUsage.properties as Json;
    expect(providerUsage.required).toEqual(
      expect.arrayContaining(['input_tokens', 'output_tokens', 'total_tokens']),
    );
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
      expect(usageProperties[field]).toMatchObject({
        anyOf: expect.arrayContaining([{ type: 'integer' }, { type: 'null' }]),
      });
    }

    expect(providerMetrics.required).toContain('ai_processing_ms');
    expect((providerMetrics.properties as Json).ai_processing_ms).toMatchObject(
      { type: 'integer' },
    );
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

    expect(allowed.map(key).filter((entry) => !current.has(entry))).toEqual([]);
  });

  it('gives every allowed difference a reason', () => {
    expect(allowed.filter((entry) => entry.reason.trim().length < 20)).toEqual(
      [],
    );
  });
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
