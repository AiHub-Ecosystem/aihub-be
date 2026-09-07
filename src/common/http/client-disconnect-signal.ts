/**
 * Structural rather than Node's own `IncomingMessage` type, for the same
 * reason as `HookableFastifyInstance` in `body-size.hook.ts`: it lets any
 * request-like object with an event-emitter shape satisfy this, independent
 * of which copy of a framework's types produced it.
 */
export interface DisconnectableRequest {
  on(event: 'close', listener: () => void): void;
  off(event: 'close', listener: () => void): void;
}

export interface DisconnectSignal {
  readonly signal: AbortSignal;
  /** Detaches the listener. Always call this once the request has settled. */
  readonly dispose: () => void;
}

/**
 * An `AbortSignal` that fires when the underlying connection for this
 * specific request closes — including a premature client disconnect, not
 * only a clean completion.
 *
 * Node's `IncomingMessage` emits `'close'` once per request even on a
 * keep-alive connection (the event is scoped to the message, not the shared
 * socket), so this is safe to attach per-request without affecting sibling
 * requests on the same connection.
 *
 * Firing after the request has already resolved is harmless: nothing is
 * listening on the signal by then, so `abort()` is a no-op. There is no need
 * to guard on whether the response was already sent.
 */
export function createClientDisconnectSignal(
  request: DisconnectableRequest,
): DisconnectSignal {
  const controller = new AbortController();
  const onClose = (): void => controller.abort();

  request.on('close', onClose);

  return {
    signal: controller.signal,
    dispose: () => request.off('close', onClose),
  };
}
