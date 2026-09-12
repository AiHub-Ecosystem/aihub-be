import { EventEmitter } from 'node:events';

import { createClientDisconnectSignal } from './client-disconnect-signal';

type TestRequest = EventEmitter & { socket: EventEmitter };

function testRequest(): TestRequest {
  const request = new EventEmitter() as TestRequest;
  request.socket = new EventEmitter();
  return request;
}

describe('createClientDisconnectSignal', () => {
  it('is not aborted before the underlying request disconnects', () => {
    const raw = testRequest();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('ignores the normal request close emitted after the body is consumed', () => {
    const raw = testRequest();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    raw.emit('close');

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('aborts the signal when the request is aborted during upload', () => {
    const raw = testRequest();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    raw.emit('aborted');

    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('aborts the signal when the client socket closes after upload', () => {
    const raw = testRequest();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    raw.socket.emit('close');

    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('detaches listeners on dispose so later disconnects do not abort', () => {
    const raw = testRequest();
    const { dispose } = createClientDisconnectSignal(raw);

    dispose();

    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
    expect(() => raw.emit('aborted')).not.toThrow();
    expect(() => raw.socket.emit('close')).not.toThrow();
  });

  it('does not affect a sibling signal on a separate request-like object', () => {
    const first = testRequest();
    const second = testRequest();
    const a = createClientDisconnectSignal(first);
    const b = createClientDisconnectSignal(second);

    first.socket.emit('close');

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);

    a.dispose();
    b.dispose();
  });
});
