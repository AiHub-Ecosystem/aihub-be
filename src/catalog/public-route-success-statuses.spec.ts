import { readFileSync } from 'node:fs';

import { Controller, HttpCode, Post } from '@nestjs/common';

import {
  answeredStatusesByRoute,
  answeredStatusesOf,
  declaredRoutes,
  statusViolations,
} from '../../test/support/route-handler-statuses';

/** A handler that answers a status its route does not declare, as a fixture. */
@Controller()
class FixtureController {
  @Post('v1/fixture')
  @HttpCode(201)
  create(reply: { status(code: number): void }): void {
    reply.status(500);
  }
}

describe('public route success statuses', () => {
  it('declares every status a handler answers on the route serving it', async () => {
    const violations = statusViolations(
      declaredRoutes(),
      await answeredStatusesByRoute(),
    );

    expect(violations).toEqual([]);
  });

  it('names the route and the offending status of a handler that over-answers', () => {
    const statuses = answeredStatusesOf(
      FixtureController,
      'create',
      readFileSync(__filename, 'utf8'),
    );
    const served = new Map([['x.route', { handler: 'create', statuses }]]);

    expect(
      statusViolations(
        [
          {
            routeId: 'x.route',
            method: 'POST',
            path: '/v1/fixture',
            statuses: [201],
          },
        ],
        served,
      ),
    ).toEqual(['x.route: create answers 500, but the route declares 201']);
  });

  it('names a declared route whose handler is not found', () => {
    expect(
      statusViolations(
        [
          {
            routeId: 'x.route',
            method: 'POST',
            path: '/v1/fixture',
            statuses: [201],
          },
        ],
        new Map(),
      ),
    ).toEqual(['x.route: no handler serves POST /v1/fixture']);
  });
});
