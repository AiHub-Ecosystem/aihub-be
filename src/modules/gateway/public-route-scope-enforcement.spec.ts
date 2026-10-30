import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Post, RequestMethod, UseGuards } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { ApiKeyUserIdentityGuard } from '@/modules/identity/api-keys/presentation/api-key-user-identity.guard';
import { ApiKeyGuard } from '@/modules/identity/api-keys/presentation/api-key.guard';
import {
  REQUIRED_API_KEY_SCOPE_METADATA,
  RequireApiKeyScope,
} from '@/modules/identity/shared/presentation/require-api-key-scope.decorator';
import { REQUIRED_OPERATION_METADATA } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { getOwnPrototypeMethod } from '../../../test/support/own-prototype-method';

type Handler = (...args: never[]) => unknown;
interface Controller_ {
  readonly prototype: object;
}

const SOURCE_ROOT = join(__dirname, '../..');

function isController(value: unknown): value is Controller_ {
  return (
    typeof value === 'function' &&
    Reflect.getMetadata(PATH_METADATA, value) !== undefined
  );
}

function joinPath(prefix: string, path: string): string {
  return `/${[prefix, path]
    .join('/')
    .split('/')
    .filter((segment) => segment !== '')
    .join('/')}`;
}

/** Every `METHOD /path` a controller serves, keyed to the handler that serves it. */
function routesServedBy(controller: Controller_): Map<string, Handler> {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;
  const routes = new Map<string, Handler>();
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const handler = prototype[name];
    if (typeof handler !== 'function') continue;
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof method !== 'number' || typeof path !== 'string') continue;
    routes.set(
      `${RequestMethod[method]} ${joinPath(prefix, path)}`,
      handler as Handler,
    );
  }
  return routes;
}

function guardsOn(target: object): unknown[] {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  return Array.isArray(guards) ? guards : [];
}

/**
 * The scope a handler's guard chain checks, or `undefined` when no guard in the
 * chain reads the declaration the handler carries. A scope decorator counts only
 * beside the guard that reads it (`ApiKeyUserIdentityGuard`); an operation
 * counts only beside `ApiKeyGuard`, which takes the scope from the catalog.
 */
function enforcedScope(
  controller: Controller_,
  handler: Handler,
): string | undefined {
  const guards = [...guardsOn(controller), ...guardsOn(handler)];
  const scope: unknown = Reflect.getMetadata(
    REQUIRED_API_KEY_SCOPE_METADATA,
    handler,
  );
  if (typeof scope === 'string' && guards.includes(ApiKeyUserIdentityGuard)) {
    return scope;
  }
  const operation: unknown = Reflect.getMetadata(
    REQUIRED_OPERATION_METADATA,
    handler,
  );
  if (
    typeof operation === 'string' &&
    operation in OPERATION_CATALOG &&
    guards.includes(ApiKeyGuard)
  ) {
    return OPERATION_CATALOG[operation as keyof typeof OPERATION_CATALOG]
      .requiredScope;
  }
  return undefined;
}

async function loadControllers(): Promise<Controller_[]> {
  const files = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.controller.ts'))
    .sort();
  const controllers: Controller_[] = [];
  for (const file of files) {
    const loaded: unknown = await import(join(SOURCE_ROOT, file));
    controllers.push(
      ...Object.values(loaded as Record<string, unknown>).filter(isController),
    );
  }
  return controllers;
}

describe('API-key route scope enforcement', () => {
  it('has a guard chain that checks the scope every API-key route declares', async () => {
    const served = new Map<
      string,
      { controller: Controller_; handler: Handler }
    >();
    for (const controller of await loadControllers()) {
      for (const [key, handler] of routesServedBy(controller)) {
        served.set(key, { controller, handler });
      }
    }

    const unenforced: Record<string, string> = {};
    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      if (route.callerAuth !== 'api-key' || !('requiredScope' in route)) {
        continue;
      }
      const entry = served.get(`${route.method} ${route.path}`);
      const enforced =
        entry === undefined
          ? undefined
          : enforcedScope(entry.controller, entry.handler);
      if (enforced !== route.requiredScope) {
        unenforced[routeId] =
          `declares ${route.requiredScope}, guard chain checks ${enforced ?? 'nothing'}`;
      }
    }

    expect(unenforced).toEqual({});
  });

  describe('enforcedScope', () => {
    class Unguarded {
      @Post('x')
      @RequireApiKeyScope('speaking.grade')
      run(): void {}
    }

    @UseGuards(ApiKeyUserIdentityGuard)
    class Guarded {
      @Post('x')
      @RequireApiKeyScope('speaking.grade')
      run(): void {}
    }

    it('returns the scope when the reading guard is in the chain', () => {
      expect(
        enforcedScope(Guarded, getOwnPrototypeMethod(Guarded.prototype, 'run')),
      ).toBe('speaking.grade');
    });

    it('returns nothing for a declared scope no guard reads', () => {
      expect(
        enforcedScope(
          Unguarded,
          getOwnPrototypeMethod(Unguarded.prototype, 'run'),
        ),
      ).toBeUndefined();
    });
  });
});
