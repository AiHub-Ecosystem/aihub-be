import { AppModule } from '@/app.module';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { WEB_SESSION_CLIENT_SECRET_HEADER } from '@/common/http/client-secret-header';
import { MfaController } from '@/modules/auth/mfa/presentation/mfa.controller';
import type { AuthClock } from '@/modules/auth/shared/application/auth-clock';
import type {
  AuthSecurityEvent,
  AuthSecurityEventRecorderPort,
} from '@/modules/auth/shared/application/auth-security-event.port';
import { SandboxDemoKeyValidationController } from '@/modules/identity/user-assertions/presentation/sandbox-demo-key-validation.controller';
import { type ExecutionContext, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  OptionalWebSessionClientGuard,
  WebSessionClientGuard,
} from './web-session-client.guard';
import { WebSessionController } from './web-session.controller';

const WEB_SESSION_GUARDS: readonly unknown[] = [
  WebSessionClientGuard,
  OptionalWebSessionClientGuard,
];

const SECURITY_EVENT_TIME = new Date('2026-11-11T12:00:00.000Z');

function clientSecretContext(secret: string | undefined): ExecutionContext {
  const request: Record<string, unknown> = {
    headers:
      secret === undefined
        ? {}
        : { [WEB_SESSION_CLIENT_SECRET_HEADER.toLowerCase()]: secret },
  };
  const context = new ExecutionContextHost([request]);
  context.setType('http');
  return context;
}

function guardHarness(configuredSecret: string | undefined) {
  const events: AuthSecurityEvent[] = [];
  const securityEvents: AuthSecurityEventRecorderPort = {
    record(event) {
      events.push(event);
    },
  };
  const secret = { resolve: () => configuredSecret };
  const clock: AuthClock = { now: () => SECURITY_EVENT_TIME };
  return { events, securityEvents, secret, clock };
}

function thrownBy(action: () => boolean): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

type Controller = new (...args: never[]) => object;

function listOf(key: string, target: object): readonly unknown[] {
  const list: unknown = Reflect.getMetadata(key, target);
  return Array.isArray(list) ? list : [];
}

/** Every controller reachable from `root` through module imports. */
function controllersOf(
  root: unknown,
  seen = new Set<unknown>(),
): Set<Controller> {
  const found = new Set<Controller>();
  const module =
    typeof root === 'object' && root !== null && 'module' in root
      ? root.module
      : root;
  if (typeof module !== 'function' || seen.has(module)) return found;
  seen.add(module);

  for (const controller of listOf(MODULE_METADATA.CONTROLLERS, module)) {
    found.add(controller as Controller);
  }
  for (const imported of listOf(MODULE_METADATA.IMPORTS, module)) {
    for (const controller of controllersOf(imported, seen)) {
      found.add(controller);
    }
  }
  return found;
}

/** Route ids of the controller's handlers that run a Web Session client guard. */
function guardedRouteIds(controller: Controller): string[] {
  const classGuards = listOf(GUARDS_METADATA, controller);
  const ids: string[] = [];

  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)
      ?.value as object | undefined;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof path !== 'string' || typeof method !== 'number') continue;

    const guards = [...classGuards, ...listOf(GUARDS_METADATA, handler)];
    if (!guards.some((guard) => WEB_SESSION_GUARDS.includes(guard))) continue;

    const [id] =
      Object.entries(PUBLIC_ROUTES).find(
        ([, route]) =>
          route.path === path && RequestMethod[route.method] === method,
      ) ?? [];
    if (id === undefined) throw new Error(`No catalogue route for ${path}`);
    ids.push(id);
  }
  return ids;
}

describe('routes behind the Web Session client guard', () => {
  const guarded = new Map(
    [...controllersOf(AppModule)].map((controller) => [
      controller,
      guardedRouteIds(controller),
    ]),
  );

  it('finds the controllers that run the guard', () => {
    for (const controller of [
      MfaController,
      WebSessionController,
      SandboxDemoKeyValidationController,
    ]) {
      expect(guarded.get(controller)?.length).toBeGreaterThan(0);
    }
  });

  it('publishes 503 for each guarded route (#934)', () => {
    const missing = [...guarded.values()].flat().filter((id) => {
      const { errorStatuses } = PUBLIC_ROUTES[id as keyof typeof PUBLIC_ROUTES];
      return Array.isArray(errorStatuses) && !errorStatuses.includes(503);
    });

    expect(missing).toEqual([]);
  });
});

describe('Web Session client-secret guard security events', () => {
  it.each([
    ['missing', undefined],
    ['invalid', 'wrong-client-secret'],
  ] as const)(
    'records one event for a required guard with a %s secret',
    (_kind, presentedSecret) => {
      const harness = guardHarness('expected-client-secret');
      const guard = new WebSessionClientGuard(
        harness.secret,
        harness.securityEvents,
        harness.clock,
      );

      expect(
        thrownBy(() => guard.canActivate(clientSecretContext(presentedSecret))),
      ).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(harness.events).toEqual([
        {
          event: 'web_session_client_secret_guard_failed',
          occurredAt: SECURITY_EVENT_TIME,
        },
      ]);
    },
  );

  it('records a supplied invalid secret for the optional guard', () => {
    const harness = guardHarness('expected-client-secret');
    const guard = new OptionalWebSessionClientGuard(
      harness.secret,
      harness.securityEvents,
      harness.clock,
    );

    expect(
      thrownBy(() =>
        guard.canActivate(clientSecretContext('wrong-client-secret')),
      ),
    ).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(harness.events).toEqual([
      {
        event: 'web_session_client_secret_guard_failed',
        occurredAt: SECURITY_EVENT_TIME,
      },
    ]);
  });

  it('does not record when the optional guard receives no secret', () => {
    const harness = guardHarness('expected-client-secret');
    const guard = new OptionalWebSessionClientGuard(
      harness.secret,
      harness.securityEvents,
      harness.clock,
    );

    expect(guard.canActivate(clientSecretContext(undefined))).toBe(true);
    expect(harness.events).toEqual([]);
  });

  it('does not count an unconfigured server secret as a client failure', () => {
    const harness = guardHarness(undefined);
    const guard = new WebSessionClientGuard(
      harness.secret,
      harness.securityEvents,
      harness.clock,
    );

    expect(
      thrownBy(() => guard.canActivate(clientSecretContext('supplied-secret'))),
    ).toMatchObject({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' });
    expect(harness.events).toEqual([]);
  });
});
