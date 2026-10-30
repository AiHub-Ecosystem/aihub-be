import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

import { OPERATION_CATALOG } from './operation-catalog';
import { PUBLIC_ROUTES } from './public-routes';

// The route and response convention of ADR-0129 (#305). The convention binds
// new routes; each route that predates it is listed in EXCEPTIONS with the
// reason it stays and the rules it is allowed to break. Any other break on an
// excepted route fails here, and so does a permitted rule the route no longer
// breaks, so the list cannot outlive what it excuses.

interface RouteFacts {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly successStatus: number;
  readonly responseSchema: TSchema | null;
  /** A graded operation of the Operation Catalog. */
  readonly graded: boolean;
}

/** First path segment after the major version. A new one is a decision. */
const TOP_LEVEL = [
  'auth',
  'ielts',
  'me',
  'organizations',
  'sandbox',
  'speaking',
];

type RuleId =
  | 'graded-name'
  | 'graded-home'
  | 'top-level'
  | 'speaking-audio'
  | 'delete-answer'
  | 'me-placement';

interface RuleBreak {
  readonly rule: RuleId;
  readonly message: string;
}

interface RouteException {
  readonly reason: string;
  /** The rules this route may break. Naming one does not excuse another. */
  readonly permits: readonly RuleId[];
}

type RouteExceptions = Readonly<Record<string, RouteException>>;

// The two Speaking grading routes were published as nouns (`.../grading`), and
// renaming a route is breaking in /v1 (ADR-0127). They may keep that name and
// nothing else: their home and top-level segment stay checked.
const LEGACY_SPEAKING_GRADING: readonly RuleId[] = ['graded-name'];

const EXCEPTIONS: RouteExceptions = {
  'speaking.grading': {
    reason:
      'Published as a noun before the convention; renaming a route is breaking in /v1 (ADR-0127). The Speaking proxy of ADR-0014.',
    permits: LEGACY_SPEAKING_GRADING,
  },
  'speaking.grading-json': {
    reason:
      'Published as a noun before the convention; renaming a route is breaking in /v1 (ADR-0127). The JSON-URL variant of the Speaking proxy (ADR-0015).',
    permits: LEGACY_SPEAKING_GRADING,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a JSON Schema object lists `name` as a required property. */
function requires(schema: unknown, name: string): boolean {
  return (
    isRecord(schema) &&
    Array.isArray(schema.required) &&
    schema.required.includes(name)
  );
}

/**
 * Whether a response envelope always carries the resulting `status` in `data`.
 * An optional property is still listed under `properties`, so the check reads
 * `required` at both levels: a response that may omit either does not state
 * the state the caller is left in.
 */
function dataCarriesStatus(schema: TSchema): boolean {
  const plain: unknown = JSON.parse(JSON.stringify(schema));
  if (!isRecord(plain) || !isRecord(plain.properties)) return false;
  const data = plain.properties.data;
  return (
    requires(plain, 'data') &&
    isRecord(data) &&
    isRecord(data.properties) &&
    'status' in data.properties &&
    requires(data, 'status')
  );
}

function ruleBreaks(route: RouteFacts): RuleBreak[] {
  const segments = route.path.split('/').filter((s) => s !== '');
  const [, top, second] = segments;
  const breaks: RuleBreak[] = [];

  if (route.graded && segments.at(-1) !== 'grade') {
    breaks.push({
      rule: 'graded-name',
      message: 'a graded route ends in /grade',
    });
  }
  if (route.graded && top !== 'ielts') {
    breaks.push({
      rule: 'graded-home',
      message: 'a graded route lives under /v1/ielts',
    });
  }
  if (top === undefined || !TOP_LEVEL.includes(top)) {
    breaks.push({
      rule: 'top-level',
      message: `the top-level segment "${top}" is not one the ADR lists`,
    });
  }
  if (top === 'speaking' && second !== 'audio') {
    breaks.push({
      rule: 'speaking-audio',
      message: '/v1/speaking holds only audio assets',
    });
  }
  if (route.method === 'DELETE') {
    const gone = route.successStatus === 204 && route.responseSchema === null;
    const kept =
      route.successStatus === 200 &&
      route.responseSchema !== null &&
      dataCarriesStatus(route.responseSchema);
    if (!gone && !kept) {
      breaks.push({
        rule: 'delete-answer',
        message:
          'a DELETE answers 204 with no body, or 200 with the resulting status',
      });
    }
  }
  segments.forEach((segment, index) => {
    const allowed = index === 1 || (top === 'organizations' && index === 2);
    if (segment === 'me' && !allowed) {
      breaks.push({
        rule: 'me-placement',
        message: '"me" is only /v1/me or /v1/organizations/me',
      });
    }
  });
  return breaks;
}

function violations(
  routes: readonly RouteFacts[],
  exceptions: RouteExceptions,
): string[] {
  const found = routes.flatMap((route) => {
    const breaks = ruleBreaks(route);
    const exception = exceptions[route.id];
    if (exception === undefined) {
      return breaks.map(({ message }) => `${route.id}: ${message}`);
    }
    if (breaks.length === 0) {
      return [
        `${route.id}: the exception is stale, the route follows the rules`,
      ];
    }
    const broken = new Set(breaks.map(({ rule }) => rule));
    return [
      ...breaks
        .filter(({ rule }) => !exception.permits.includes(rule))
        .map(({ message }) => `${route.id}: ${message}`),
      ...exception.permits
        .filter((rule) => !broken.has(rule))
        .map(
          (rule) =>
            `${route.id}: the exception permits "${rule}" but the route no longer breaks it`,
        ),
    ];
  });
  const known = new Set(routes.map((route) => route.id));
  const missing = Object.keys(exceptions)
    .filter((id) => !known.has(id))
    .map((id) => `${id}: the exception names no route`);
  return [...found, ...missing];
}

function route(overrides: Partial<RouteFacts> & { id: string }): RouteFacts {
  return {
    method: 'POST',
    path: '/v1/organizations/{organization_id}/things',
    successStatus: 201,
    responseSchema: Type.Object({ data: Type.Object({}) }),
    graded: false,
    ...overrides,
  };
}

const WITH_STATUS = Type.Object({
  data: Type.Object({ status: Type.String() }),
});
const NO_STATUS = Type.Object({ data: Type.Object({ id: Type.String() }) });
const OPTIONAL_STATUS = Type.Object({
  data: Type.Object({ status: Type.Optional(Type.String()) }),
});
const OPTIONAL_DATA = Type.Object({
  data: Type.Optional(Type.Object({ status: Type.String() })),
});

describe('public route convention (ADR-0129)', () => {
  it('names a graded route that does not end in /grade, and accepts an excused one', () => {
    const noun = route({
      id: 'x.grading',
      path: '/v1/ielts/x/grading',
      graded: true,
    });

    expect(violations([noun], {})).toEqual([
      'x.grading: a graded route ends in /grade',
    ]);
    expect(
      violations([noun], {
        'x.grading': { reason: 'predates it', permits: ['graded-name'] },
      }),
    ).toEqual([]);
  });

  it('names a graded route outside /v1/ielts', () => {
    const outside = route({
      id: 'x.grade',
      path: '/v1/x/grade',
      graded: true,
    });

    expect(violations([outside], {})).toEqual(
      expect.arrayContaining([
        'x.grade: a graded route lives under /v1/ielts',
        'x.grade: the top-level segment "x" is not one the ADR lists',
      ]),
    );
  });

  it('holds /v1/speaking to audio assets', () => {
    const job = route({ id: 'x.job', path: '/v1/speaking/grade' });
    const audio = route({ id: 'x.audio', path: '/v1/speaking/audio/uploads' });

    expect(violations([job, audio], {})).toEqual([
      'x.job: /v1/speaking holds only audio assets',
    ]);
  });

  it('accepts a DELETE that is gone (204, no body) or kept (200, with its status)', () => {
    expect(
      violations(
        [
          route({
            id: 'a',
            method: 'DELETE',
            successStatus: 204,
            responseSchema: null,
          }),
          route({
            id: 'b',
            method: 'DELETE',
            successStatus: 200,
            responseSchema: WITH_STATUS,
          }),
        ],
        {},
      ),
    ).toEqual([]);
  });

  it('names a DELETE whose 200 status is optional or sits in an optional data', () => {
    const rule =
      'a DELETE answers 204 with no body, or 200 with the resulting status';

    expect(
      violations(
        [
          route({
            id: 'a',
            method: 'DELETE',
            successStatus: 200,
            responseSchema: OPTIONAL_STATUS,
          }),
          route({
            id: 'b',
            method: 'DELETE',
            successStatus: 200,
            responseSchema: OPTIONAL_DATA,
          }),
        ],
        {},
      ),
    ).toEqual([`a: ${rule}`, `b: ${rule}`]);
  });

  it('names a DELETE that answers 200 without a status, or 204 with a body', () => {
    const rule =
      'a DELETE answers 204 with no body, or 200 with the resulting status';

    expect(
      violations(
        [
          route({
            id: 'a',
            method: 'DELETE',
            successStatus: 200,
            responseSchema: NO_STATUS,
          }),
          route({
            id: 'b',
            method: 'DELETE',
            successStatus: 204,
            responseSchema: WITH_STATUS,
          }),
        ],
        {},
      ),
    ).toEqual([`a: ${rule}`, `b: ${rule}`]);
  });

  it('allows "me" only as /v1/me or /v1/organizations/me', () => {
    const rule = '"me" is only /v1/me or /v1/organizations/me';

    expect(
      violations(
        [
          route({ id: 'a', path: '/v1/me/avatar' }),
          route({ id: 'b', path: '/v1/organizations/me/members' }),
          route({ id: 'c', path: '/v1/organizations/{organization_id}/me' }),
          route({ id: 'd', path: '/v1/auth/me' }),
        ],
        {},
      ),
    ).toEqual([`c: ${rule}`, `d: ${rule}`]);
  });

  it('still names a break an exception does not list', () => {
    const moved = route({
      id: 'speaking.grading',
      path: '/v1/widgets/grading',
      graded: true,
    });

    // Only this route's exception, so the other one is not reported as naming
    // no route.
    const legacy = Object.fromEntries(
      Object.entries(EXCEPTIONS).filter(([id]) => id === moved.id),
    );

    expect(violations([moved], legacy)).toEqual([
      'speaking.grading: a graded route lives under /v1/ielts',
      'speaking.grading: the top-level segment "widgets" is not one the ADR lists',
    ]);
  });

  it('names a permitted break the route no longer has', () => {
    const renamed = route({
      id: 'x.grade',
      path: '/v1/ielts/x/grade',
      graded: true,
    });
    const stillExcused: RouteExceptions = {
      'x.grade': { reason: 'predates it', permits: ['graded-name'] },
    };

    expect(violations([renamed], stillExcused)).toEqual([
      'x.grade: the exception is stale, the route follows the rules',
    ]);

    const partlyFixed = route({
      id: 'x.grading',
      path: '/v1/speaking/grading',
      graded: true,
    });
    expect(
      violations([partlyFixed], {
        'x.grading': {
          reason: 'predates it',
          permits: [
            'graded-name',
            'graded-home',
            'speaking-audio',
            'me-placement',
          ],
        },
      }),
    ).toEqual([
      'x.grading: the exception permits "me-placement" but the route no longer breaks it',
    ]);
  });

  it('names an exception that excuses nothing', () => {
    const fine = route({ id: 'x.fine', path: '/v1/me' });

    expect(
      violations([fine], {
        'x.fine': { reason: 'old', permits: ['top-level'] },
        'x.gone': { reason: 'old', permits: ['top-level'] },
      }),
    ).toEqual([
      'x.fine: the exception is stale, the route follows the rules',
      'x.gone: the exception names no route',
    ]);
  });

  it('holds every published route to the convention', () => {
    const published: RouteFacts[] = [
      ...Object.entries(PUBLIC_ROUTES).map(([id, def]) => ({
        id,
        method: def.method,
        path: def.path,
        successStatus: def.successStatus,
        responseSchema: def.responseSchema,
        graded: false,
      })),
      ...Object.entries(OPERATION_CATALOG).map(([id, def]) => ({
        id,
        method: def.method,
        path: def.path,
        successStatus: 200,
        responseSchema: null,
        graded: true,
      })),
    ];

    expect(violations(published, EXCEPTIONS)).toEqual([]);
  });
});
