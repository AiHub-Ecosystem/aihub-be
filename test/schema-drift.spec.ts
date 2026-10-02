import { type Drift, schemaDrift } from './support/schema-drift';

type Schema = Record<string, unknown>;

function drift(provider: Schema, ours: Schema, doc: Schema = {}): string[] {
  return schemaDrift({ node: provider, doc }, { node: ours, doc: {} }).map(
    (entry: Drift) => `${entry.kind} ${entry.path}`,
  );
}

const OBJECT = (
  properties: Schema,
  required: string[] = [],
  extra: Schema = {},
): Schema => ({ type: 'object', properties, required, ...extra });

describe('schemaDrift', () => {
  it('finds nothing when the two schemas agree', () => {
    const schema = OBJECT({ name: { type: 'string' } }, ['name']);

    expect(drift(schema, schema)).toEqual([]);
  });

  it('flags a value the provider allows to be null and AIHUB does not', () => {
    const provider = OBJECT(
      { stress: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
      ['stress'],
    );
    const ours = OBJECT({ stress: { type: 'integer' } }, ['stress']);

    expect(drift(provider, ours)).toEqual(['nullable data.stress']);
  });

  it('does not flag AIHUB allowing null where the provider does not', () => {
    const provider = OBJECT({ stress: { type: 'integer' } }, ['stress']);
    const ours = OBJECT(
      { stress: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
      ['stress'],
    );

    expect(drift(provider, ours)).toEqual([]);
  });

  it('flags a field the provider may omit and AIHUB requires', () => {
    const provider = OBJECT({ note: { type: 'string' } }, []);
    const ours = OBJECT({ note: { type: 'string' } }, ['note']);

    expect(drift(provider, ours)).toEqual(['optional data.note']);
  });

  it('does not flag AIHUB treating a required field as optional', () => {
    const provider = OBJECT({ note: { type: 'string' } }, ['note']);
    const ours = OBJECT({ note: { type: 'string' } }, []);

    expect(drift(provider, ours)).toEqual([]);
  });

  it('flags a different type', () => {
    const provider = OBJECT({ count: { type: 'number' } }, ['count']);
    const ours = OBJECT({ count: { type: 'string' } }, ['count']);

    expect(drift(provider, ours)).toEqual(['type data.count']);
  });

  it('flags an enum value the provider may send and AIHUB does not list', () => {
    const provider = OBJECT({ mode: { enum: ['a', 'b'] } }, ['mode']);
    const ours = OBJECT({ mode: { anyOf: [{ const: 'a' }] } }, ['mode']);

    expect(drift(provider, ours)).toEqual(['enum data.mode']);
  });

  it('flags a key the provider has inside a closed AIHUB object, but not at the top', () => {
    const provider = OBJECT(
      {
        inner: OBJECT({ a: { type: 'string' }, extra: { type: 'string' } }, [
          'a',
        ]),
        top_only: { type: 'string' },
      },
      ['inner'],
    );
    const ours = OBJECT(
      {
        inner: OBJECT({ a: { type: 'string' } }, ['a'], {
          additionalProperties: false,
        }),
      },
      ['inner'],
      { additionalProperties: false },
    );

    // AIHUB drops unknown top-level keys by design, so only the nested one counts.
    expect(drift(provider, ours)).toEqual(['extra-key data.inner.extra']);
  });

  it('follows references and arrays', () => {
    const doc = {
      components: {
        schemas: {
          Item: OBJECT({ v: { type: 'integer' } }, []),
        },
      },
    };
    const provider = OBJECT(
      {
        items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
      },
      ['items'],
    );
    const ours = OBJECT(
      {
        items: {
          type: 'array',
          items: OBJECT({ v: { type: 'integer' } }, ['v']),
        },
      },
      ['items'],
    );

    expect(drift(provider, ours, doc)).toEqual(['optional data.items[].v']);
  });

  it('ignores numeric bounds, which AIHUB is free to tighten', () => {
    const provider = OBJECT({ score: { type: 'number' } }, ['score']);
    const ours = OBJECT(
      { score: { type: 'number', minimum: 0, maximum: 100 } },
      ['score'],
    );

    expect(drift(provider, ours)).toEqual([]);
  });
});
