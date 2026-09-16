import {
  CliUsageError,
  booleanOption,
  environmentListOption,
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

describe('environmentListOption', () => {
  it('defaults key creation to production', () => {
    expect(environmentListOption(options(), 'envs')).toEqual(['production']);
  });

  it.each(['development', 'staging', 'production', 'sandbox'])(
    'accepts %s',
    (environment) => {
      expect(
        environmentListOption(options({ envs: environment }), 'envs'),
      ).toEqual([environment]);
    },
  );

  it('accepts multiple non-sandbox environments', () => {
    expect(
      environmentListOption(options({ envs: 'development,staging' }), 'envs'),
    ).toEqual(['development', 'staging']);
  });

  it.each([
    'unknown',
    '',
    'production,',
    'production,production',
    'sandbox,production',
    'sandbox,staging',
    'sandbox,development',
  ])('rejects invalid environment list %s', (value) => {
    expect(() =>
      environmentListOption(options({ envs: value }), 'envs'),
    ).toThrow(CliUsageError);
  });
});
