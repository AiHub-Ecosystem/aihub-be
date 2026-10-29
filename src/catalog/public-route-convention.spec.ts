import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

import { OPERATION_CATALOG } from './operation-catalog';
import { PUBLIC_ROUTES } from './public-routes';

// The route and response convention of ADR-0129 (#305). The convention binds
// new routes; each route that predates it is listed in EXCEPTIONS with the
// reason it stays. An exception that no longer breaks a rule fails here, so the
// list cannot outlive what it excuses.

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

const EXCEPTIONS: Readonly<Record<string, string>> = {
  'speaking.grading':
    'Published as a noun before the convention; renaming a route is breaking in /v1 (ADR-0127). The Speaking proxy of ADR-0014.',
  'speaking.grading-json':
    'Published as a noun before the convention; renaming a route is breaking in /v1 (ADR-0127). The JSON-URL variant of the Speaking proxy (ADR-0015).',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a response envelope's `data` carries the resulting `status`. */
function dataCarriesStatus(schema: TSchema): boolean {
  const plain: unknown = JSON.parse(JSON.stringify(schema));
  if (!isRecord(plain) || !isRecord(plain.properties)) return false;
  const data = plain.properties.data;
  return (
    isRecord(data) && isRecord(data.properties) && 'status' in data.properties
  );
}

function ruleBreaks(route: RouteFacts): string[] {
  const segments = route.path.split('/').filter((s) => s !== '');
  const [, top, second] = segments;
  const breaks: string[] = [];

  if (route.graded && segments.at(-1) !== 'grade') {
    breaks.push('a graded route ends in /grade');
  }
  if (route.graded && top !== 'ielts') {
    breaks.push('a graded route lives under /v1/ielts');
  }
  if (top === undefined || !TOP_LEVEL.includes(top)) {
    breaks.push(`the top-level segment "${top}" is not one the ADR lists`);
  }
  if (top === 'speaking' && second !== 'audio') {
    breaks.push('/v1/speaking holds only audio assets');
  }
  if (route.method === 'DELETE') {
    const gone = route.successStatus === 204 && route.responseSchema === null;
    const kept =
      route.successStatus === 200 &&
      route.responseSchema !== null &&
      dataCarriesStatus(route.responseSchema);
    if (!gone && !kept) {
      breaks.push(
        'a DELETE answers 204 with no body, or 200 with the resulting status',
      );
    }
  }
  segments.forEach((segment, index) => {
    const allowed = index === 1 || (top === 'organizations' && index === 2);
    if (segment === 'me' && !allowed) {
      breaks.push('"me" is only /v1/me or /v1/organizations/me');
    }
  });
  return breaks;
}

function violations(
  routes: readonly RouteFacts[],
  exceptions: Readonly<Record<string, string>>,
): string[] {
  const found = routes.flatMap((route) => {
    const breaks = ruleBreaks(route);
    if (route.id in exceptions) {
      return breaks.length === 0
        ? [`${route.id}: the exception is stale, the route follows the rules`]
        : [];
    }
    return breaks.map((rule) => `${route.id}: ${rule}`);
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
    expect(violations([noun], { 'x.grading': 'predates it' })).toEqual([]);
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

  it('names an exception that excuses nothing', () => {
    const fine = route({ id: 'x.fine', path: '/v1/me' });

    expect(violations([fine], { 'x.fine': 'old', 'x.gone': 'old' })).toEqual([
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
