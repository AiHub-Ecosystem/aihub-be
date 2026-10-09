import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { activeSlot, renderNginxConfig, renderNginxPair, slotForPort } =
  require('../../scripts/ops/blue-green-state.cjs') as {
    activeSlot(config: string, tier: 'production' | 'sandbox'): 'a' | 'b';
    renderNginxConfig(
      template: string,
      tier: 'production' | 'sandbox',
      slot: 'a' | 'b',
    ): string;
    renderNginxPair(input: {
      apiTemplate: string;
      sandboxTemplate: string;
      currentApi: string;
      currentSandbox: string;
      tier: 'production' | 'sandbox';
      nextSlot: 'a' | 'b';
      sandboxEnabled: boolean;
    }): { api: string; sandbox: string | undefined };
    slotForPort(tier: 'production' | 'sandbox', port: number): 'a' | 'b';
  };

const root = resolve(__dirname, '../..');
const apiTemplate = readFileSync(
  resolve(root, 'ops/nginx/aihub-api.conf'),
  'utf8',
);
const sandboxTemplate = readFileSync(
  resolve(root, 'ops/nginx/sandbox.conf'),
  'utf8',
);

describe('blue-green nginx slot state', () => {
  it('maps only the four reserved loopback ports to their tier slots', () => {
    expect(slotForPort('production', 3021)).toBe('a');
    expect(slotForPort('production', 3023)).toBe('b');
    expect(slotForPort('sandbox', 3022)).toBe('a');
    expect(slotForPort('sandbox', 3024)).toBe('b');
    expect(() => slotForPort('production', 3022)).toThrow(
      'unsupported production upstream port: 3022',
    );
  });

  it('reads the active slot only when every proxy route agrees', () => {
    const productionB = renderNginxConfig(apiTemplate, 'production', 'b');
    expect(activeSlot(productionB, 'production')).toBe('b');
    expect(() =>
      activeSlot(
        `${productionB}\nproxy_pass http://127.0.0.1:3021;`,
        'production',
      ),
    ).toThrow('production nginx config must have one active upstream port');
  });

  it('switches only the requested tier and preserves the other active port', () => {
    const currentApi = renderNginxConfig(apiTemplate, 'production', 'b');
    const currentSandbox = renderNginxConfig(sandboxTemplate, 'sandbox', 'a');

    const switched = renderNginxPair({
      apiTemplate,
      sandboxTemplate,
      currentApi,
      currentSandbox,
      tier: 'sandbox',
      nextSlot: 'b',
      sandboxEnabled: true,
    });

    expect(activeSlot(switched.api, 'production')).toBe('b');
    expect(activeSlot(switched.sandbox!, 'sandbox')).toBe('b');
  });

  it('keeps Sandbox absent when the tier is disabled', () => {
    const switched = renderNginxPair({
      apiTemplate,
      sandboxTemplate,
      currentApi: apiTemplate,
      currentSandbox: '',
      tier: 'production',
      nextSlot: 'b',
      sandboxEnabled: false,
    });

    expect(activeSlot(switched.api, 'production')).toBe('b');
    expect(switched.sandbox).toBeUndefined();
  });
});
