import { Transform } from 'node:stream';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { timeoutError } from '@/common/errors/app-error';
import { getRequestLifecycle } from '@/common/http/hooks/request-lifecycle.hook';
import { isRecord } from '@/common/is-record';

const JSON_PATH = OPERATION_CATALOG['speaking.grading-json'].path;

interface PayloadStream {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
  once(event: 'close' | 'error', listener: () => void): this;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
  destroy(error?: Error): void;
}

interface JsonRouteOptions {
  url?: string;
  method?: string | readonly string[];
  preParsing?: PreParsingHook;
}

type PreParsingHook = (
  request: JsonBodyRequest,
  reply: unknown,
  payload: unknown,
  done: (error?: Error | null, payload?: unknown) => void,
) => void;

interface RouteHookableInstance {
  addHook(...args: never[]): unknown;
}

interface JsonBodyRequest {
  readonly raw: unknown;
}

function isPayloadStream(value: unknown): value is PayloadStream {
  return (
    isRecord(value) &&
    'on' in value &&
    typeof value['on'] === 'function' &&
    'once' in value &&
    typeof value['once'] === 'function' &&
    'pipe' in value &&
    typeof value['pipe'] === 'function' &&
    'destroy' in value &&
    typeof value['destroy'] === 'function'
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

function cancelAtDeadline(
  request: JsonBodyRequest,
  _reply: unknown,
  payload: unknown,
  done: (error?: Error | null, payload?: unknown) => void,
): void {
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
}

export function registerSpeakingJsonBodyCancellation(
  instance: RouteHookableInstance,
): void {
  Reflect.apply(instance.addHook.bind(instance), instance, [
    'onRoute',
    (route: JsonRouteOptions): void => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      if (route.url !== JSON_PATH || !methods.includes('POST')) {
        return;
      }

      // No route declares its own `preParsing`; assigning keeps this the one owner.
      route.preParsing = cancelAtDeadline;
    },
  ]);
}
