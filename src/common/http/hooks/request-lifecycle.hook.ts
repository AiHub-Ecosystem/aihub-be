import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { matchesPathTemplate } from '@/catalog/path-template';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { pathnameOf } from '@/common/http/request-path';
import {
  type DisconnectableRequest,
  createClientDisconnectSignal,
} from '@/common/http/runtime/client-disconnect-signal';
import { isRecord } from '@/common/is-record';

const OPERATION_TIMEOUT_BY_PATH: ReadonlyMap<string, number> = new Map(
  Object.values(OPERATION_CATALOG).map((operation) => [
    operation.path,
    operation.timeoutMs,
  ]),
);
const OPERATION_TIMEOUTS = Object.values(OPERATION_CATALOG);

const TIMED_ROUTES = Object.values(PUBLIC_ROUTES).flatMap((route) =>
  'timeoutMs' in route
    ? [
        {
          method: route.method,
          path: new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`),
          timeoutMs: route.timeoutMs,
        },
      ]
    : [],
);

interface LifecycleRequest {
  readonly method: string;
  readonly url: string;
  readonly raw: DisconnectableRequest;
}

export interface RequestLifecycleState {
  readonly receivedAt: Date;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

interface LifecycleHookableInstance {
  addHook(...args: never[]): unknown;
}

const lifecycleByRequest = new WeakMap<object, RequestLifecycleState>();

export function createRequestLifecycleState(
  rawRequest: DisconnectableRequest,
  timeoutMs: number,
  onDispose: () => void = () => undefined,
): RequestLifecycleState {
  const disconnect = createClientDisconnectSignal(rawRequest);
  const receivedAt = new Date();
  const signal = AbortSignal.any([
    disconnect.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let disposed = false;

  return {
    receivedAt,
    signal,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      disconnect.dispose();
      onDispose();
    },
  };
}

export function getRequestLifecycle(
  rawRequest: unknown,
): RequestLifecycleState | undefined {
  return isRecord(rawRequest) ? lifecycleByRequest.get(rawRequest) : undefined;
}

export function registerRequestLifecycle(
  instance: LifecycleHookableInstance,
): void {
  Reflect.apply(instance.addHook.bind(instance), instance, [
    'onRequest',
    (request: LifecycleRequest, _reply: unknown, done: () => void): void => {
      const path = pathnameOf(request.url);
      const timeoutMs =
        OPERATION_TIMEOUT_BY_PATH.get(path) ??
        OPERATION_TIMEOUTS.find(
          (operation) =>
            operation.method === request.method &&
            matchesPathTemplate(operation.path, path),
        )?.timeoutMs ??
        TIMED_ROUTES.find(
          (route) => route.method === request.method && route.path.test(path),
        )?.timeoutMs;
      if (timeoutMs === undefined || !isRecord(request.raw)) {
        done();
        return;
      }

      const existing = lifecycleByRequest.get(request.raw);
      existing?.dispose();

      const state = createRequestLifecycleState(request.raw, timeoutMs, () =>
        lifecycleByRequest.delete(request.raw),
      );

      lifecycleByRequest.set(request.raw, state);
      done();
    },
  ]);

  Reflect.apply(instance.addHook.bind(instance), instance, [
    'onResponse',
    // Three parameters, not one: Fastify runs this hook chain itself and only
    // advances to the next `onResponse` hook when the previous one takes the
    // `done` callback. A one-parameter handler looks promise-style, returns
    // undefined, and silently ends the chain — so any hook registered after
    // this one, such as the Request Completion Event, would never run.
    (request: LifecycleRequest, _reply: unknown, done: () => void): void => {
      getRequestLifecycle(request.raw)?.dispose();
      done();
    },
  ]);
}
