import { Transform } from 'node:stream';

import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { AppError } from '../errors/app-error';
import {
  type DisconnectableRequest,
  createClientDisconnectSignal,
} from './client-disconnect-signal';

const OPERATION_TIMEOUT_BY_PATH: ReadonlyMap<string, number> = new Map(
  Object.values(OPERATION_CATALOG).map((operation) => [
    operation.path,
    operation.timeoutMs,
  ]),
);
const JSON_PATH = OPERATION_CATALOG['speaking.grading-json'].path;

interface LifecycleRequest {
  readonly url: string;
  readonly raw: DisconnectableRequest;
}

interface PayloadStream {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
  once(event: 'close' | 'error', listener: () => void): this;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
  destroy(error?: Error): void;
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

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function pathnameOf(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function timeoutError(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    retryable: true,
  });
}

function isPayloadStream(value: unknown): value is PayloadStream {
  return (
    isObject(value) &&
    'on' in value &&
    typeof value.on === 'function' &&
    'once' in value &&
    typeof value.once === 'function' &&
    'pipe' in value &&
    typeof value.pipe === 'function' &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

function byteLength(chunk: Uint8Array | string): number {
  return typeof chunk === 'string'
    ? Buffer.byteLength(chunk)
    : chunk.byteLength;
}

function abortablePayload(
  payload: PayloadStream,
  signal: AbortSignal,
): Transform {
  let receivedEncodedLength = 0;
  const guarded = new Transform({
    transform(chunk: Uint8Array | string, _encoding, callback): void {
      if (signal.aborted) {
        callback(timeoutError());
        return;
      }

      receivedEncodedLength += byteLength(chunk);
      callback(null, chunk);
    },
  });

  Object.defineProperty(guarded, 'receivedEncodedLength', {
    enumerable: true,
    get: () => receivedEncodedLength,
  });

  const onAbort = (): void => {
    const error = timeoutError();
    payload.destroy(error);
    guarded.destroy(error);
  };
  const cleanup = (): void => {
    signal.removeEventListener('abort', onAbort);
  };

  signal.addEventListener('abort', onAbort, { once: true });
  guarded.once('close', cleanup);
  guarded.once('error', cleanup);
  payload.pipe(guarded);

  if (signal.aborted) {
    onAbort();
  }

  return guarded;
}

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
  return isObject(rawRequest) ? lifecycleByRequest.get(rawRequest) : undefined;
}

export function registerRequestLifecycle(
  instance: LifecycleHookableInstance,
): void {
  Reflect.apply(instance.addHook, instance, [
    'onRequest',
    (request: LifecycleRequest, _reply: unknown, done: () => void): void => {
      const timeoutMs = OPERATION_TIMEOUT_BY_PATH.get(pathnameOf(request.url));
      if (timeoutMs === undefined || !isObject(request.raw)) {
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

  Reflect.apply(instance.addHook, instance, [
    'preParsing',
    (
      request: LifecycleRequest,
      _reply: unknown,
      payload: unknown,
      done: (error?: Error | null, payload?: unknown) => void,
    ): void => {
      if (pathnameOf(request.url) !== JSON_PATH) {
        done(null, payload);
        return;
      }

      const lifecycle = getRequestLifecycle(request.raw);
      if (lifecycle === undefined || !isPayloadStream(payload)) {
        done(null, payload);
        return;
      }

      if (lifecycle.signal.aborted) {
        done(timeoutError());
        return;
      }

      done(null, abortablePayload(payload, lifecycle.signal));
    },
  ]);

  Reflect.apply(instance.addHook, instance, [
    'onResponse',
    (request: LifecycleRequest): void => {
      getRequestLifecycle(request.raw)?.dispose();
    },
  ]);
}
