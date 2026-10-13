import {
  CliUsageError,
  booleanOption,
  environmentOption,
  quotaOption,
} from './cli-options.cjs';

function options(
  entries: Readonly<Record<string, string>> = {},
): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('quotaOption', () => {
  it('reads an absent quota as unlimited', () => {
    expect(quotaOption(options(), 'monthly-quota')).toBeNull();
  });

  it('reads a ceiling', () => {
    expect(
      quotaOption(options({ 'monthly-quota': '500' }), 'monthly-quota'),
    ).toBe(500);
  });

  // Freezing an organization without revoking its keys.
  it('accepts zero', () => {
    expect(
      quotaOption(options({ 'monthly-quota': '0' }), 'monthly-quota'),
    ).toBe(0);
  });

  it.each([
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['not a number', 'lots'],
    ['blank', '   '],
  ])('rejects a %s quota', (_label, value) => {
    expect(() => quotaOption(options({ q: value }), 'q')).toThrow(
      CliUsageError,
    );
  });
});

describe('booleanOption', () => {
  it('falls back when absent', () => {
    expect(booleanOption(options(), 'hard-stop')).toBe(false);
    expect(booleanOption(options(), 'hard-stop', true)).toBe(true);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
  ])('reads %s', (value, expected) => {
    expect(booleanOption(options({ 'hard-stop': value }), 'hard-stop')).toBe(
      expected,
    );
  });

  // A quota that silently stops being enforced because someone wrote `yes` is
  // the failure this rejects.
  it.each([['yes'], ['1'], ['on'], ['']])(
    'rejects %s rather than reading it as a boolean',
    (value) => {
      expect(() =>
        booleanOption(options({ 'hard-stop': value }), 'hard-stop'),
      ).toThrow(CliUsageError);
    },
  );
});

describe('environmentOption', () => {
  it('defaults key creation to production', () => {
    expect(environmentOption(options(), 'envs')).toBe('production');
  });

  it.each(['development', 'staging', 'production', 'sandbox'])(
    'accepts %s',
    (environment) => {
      expect(environmentOption(options({ envs: environment }), 'envs')).toBe(
        environment,
      );
    },
  );

  // A new key has exactly one environment, so a list is refused outright.
  it.each([
    'unknown',
    '',
    'production,',
    'production,production',
    'sandbox,production',
    'development,staging',
  ])('rejects %s', (value) => {
    expect(() => environmentOption(options({ envs: value }), 'envs')).toThrow(
      CliUsageError,
    );
  });
});
