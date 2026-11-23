/**
 * Structural rather than Node's own `IncomingMessage` type, for the same
 * reason as `HookableFastifyInstance` in `body-size.hook.ts`: it lets any
 * request-like object with an event-emitter shape satisfy this, independent
 * of which copy of a framework's types produced it.
 */
export interface DisconnectableRequest {
  on(event: 'aborted', listener: () => void): void;
  off(event: 'aborted', listener: () => void): void;
  readonly socket?: DisconnectableSocket;
}

export interface DisconnectableSocket {
  on(event: 'close', listener: () => void): void;
  off(event: 'close', listener: () => void): void;
}

export interface DisconnectSignal {
  readonly signal: AbortSignal;
  /** Detaches the listener. Always call this once the request has settled. */
  readonly dispose: () => void;
}

/**
 * An `AbortSignal` that fires when the client disconnects from this request.
 *
 * `IncomingMessage` emits `'close'` when the request body has been consumed,
 * so it cannot be used as a disconnect signal. `'aborted'` covers a client
 * that disconnects during upload; the socket's `'close'` covers a client that
 * disconnects while the downstream request is still running.
 *
 * Firing after the request has already resolved is harmless: nothing is
 * listening on the signal by then, so `abort()` is a no-op. There is no need
 * to guard on whether the response was already sent.
 */
export function createClientDisconnectSignal(
  request: DisconnectableRequest,
): DisconnectSignal {
  const controller = new AbortController();
  const onDisconnect = (): void => controller.abort();
  const socket = request.socket;

  request.on('aborted', onDisconnect);
  socket?.on('close', onDisconnect);

  return {
    signal: controller.signal,
    dispose: () => {
      request.off('aborted', onDisconnect);
      socket?.off('close', onDisconnect);
    },
  };
}
