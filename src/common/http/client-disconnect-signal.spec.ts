import { EventEmitter } from 'node:events';

import { createClientDisconnectSignal } from './client-disconnect-signal';

describe('createClientDisconnectSignal', () => {
  it('is not aborted before the underlying request closes', () => {
    const raw = new EventEmitter();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('aborts the signal when the underlying request closes', () => {
    const raw = new EventEmitter();
    const { signal, dispose } = createClientDisconnectSignal(raw);

    raw.emit('close');

    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('detaches the listener on dispose so a later close does not throw', () => {
    const raw = new EventEmitter();
    const { dispose } = createClientDisconnectSignal(raw);

    dispose();

    expect(raw.listenerCount('close')).toBe(0);
    expect(() => raw.emit('close')).not.toThrow();
  });

  it('does not affect a sibling signal on a separate request-like object', () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    const a = createClientDisconnectSignal(first);
    const b = createClientDisconnectSignal(second);

    first.emit('close');

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);

    a.dispose();
    b.dispose();
  });
});
