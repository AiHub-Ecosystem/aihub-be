import { lintFixture } from './support/lint-fixture';

const LINT_ARGS = [
  '--no-script',
  '--allow=typescript/no-unsafe-assignment',
  '--allow=typescript/no-unsafe-member-access',
  '--allow=typescript/no-unsafe-call',
  '--allow=typescript/no-unsafe-return',
  '--allow=typescript/no-unsafe-argument',
  '--no-ignore',
  '--format=unix',
];
const OPTIONS = {
  fileName: 'expect-expect.spec.ts',
  args: LINT_ARGS,
} as const;

describe('jest/expect-expect', () => {
  it('accepts a test whose assertion is made through expectRefused', () => {
    const result = lintFixture(
      `
      function expectRefused(): void {}
      describe('query refusals', () => {
        it('counts a shared assertion helper', () => {
          expectRefused();
        });
      });
    `,
      OPTIONS,
    );

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('jest/expect-expect');
  });

  it('still rejects a test with no assertion', () => {
    const result = lintFixture(
      `
      describe('query refusals', () => {
        it('has no assertion', () => {});
      });
    `,
      OPTIONS,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('expect-expect');
  });
});
