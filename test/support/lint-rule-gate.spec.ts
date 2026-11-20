import { lintFixture } from './lint-fixture';

const LINT_ARGS = ['--no-script', '--no-type-aware', '--format=unix'];
const CONFIG_IN_FIXTURE = {
  fileName: 'src/fixture.ts',
  args: LINT_ARGS,
  configInFixture: true,
} as const;

const ACCEPTED = `export function first(value: string | undefined): string {
  return value ?? '';
}
`;

describe('issue #1346 lint gates', () => {
  it('rejects a non-null assertion and accepts the narrow fallback', () => {
    const rejected = lintFixture(
      `export function first(value: string | undefined): string {
  return value!;
}
`,
      CONFIG_IN_FIXTURE,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('typescript(no-non-null-assertion)');

    const accepted = lintFixture(ACCEPTED, CONFIG_IN_FIXTURE);
    expect(accepted.status).toBe(0);
    expect(accepted.output).not.toContain('no-non-null-assertion');
  });

  it('rejects a missing exported return type and accepts an explicit one', () => {
    const rejected = lintFixture(
      `export function first(value: string) {
  return value;
}
`,
      CONFIG_IN_FIXTURE,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain(
      'typescript(explicit-module-boundary-types)',
    );

    const accepted = lintFixture(ACCEPTED, CONFIG_IN_FIXTURE);
    expect(accepted.status).toBe(0);
    expect(accepted.output).not.toContain('explicit-module-boundary-types');
  });
});
