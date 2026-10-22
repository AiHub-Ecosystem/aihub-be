import { organizationName } from './organization-name';

describe('organizationName', () => {
  it('stores the trimmed name, emoji sequences included', () => {
    expect(organizationName('  Acme Ltd  ')).toBe('Acme Ltd');
    expect(organizationName('\u00A0Acme\u00A0')).toBe('Acme');
    expect(organizationName('Acme 👨‍👩‍👧')).toBe('Acme 👨‍👩‍👧');
    expect(organizationName('Trường Anh Ngữ')).toBe('Trường Anh Ngữ');
  });

  it.each([
    ['blank', '   '],
    ['over 100 characters', 'a'.repeat(101)],
    ['a line break', 'Acme\nYour account is suspended'],
    ['a carriage return', 'Acme\rLtd'],
    ['a tab', 'Acme\tLtd'],
    ['a C1 control', 'Acme\u0085Ltd'],
    ['a line separator', 'Acme\u2028Ltd'],
    ['a right-to-left override', 'Acme \u202Edtl'],
    ['a directional isolate', 'Acme \u2067Ltd\u2069'],
    ['a directional mark', 'Acme\u200FLtd'],
  ])('refuses a name with %s', (_label, name) => {
    expect(organizationName(name)).toBeUndefined();
  });
});
