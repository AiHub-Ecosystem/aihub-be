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

describe('issue #1832 lint gates', () => {
  it('rejects a Node built-in without the node: protocol', () => {
    const rejected = lintFixture(
      `import { readFileSync } from 'fs';

export function read(path: string): string {
  return readFileSync(path, 'utf8');
}
`,
      CONFIG_IN_FIXTURE,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('unicorn(prefer-node-protocol)');
  });

  it('accepts the same import through the node: protocol', () => {
    const accepted = lintFixture(
      `import { readFileSync } from 'node:fs';

export function read(path: string): string {
  return readFileSync(path, 'utf8');
}
`,
      CONFIG_IN_FIXTURE,
    );
    expect(accepted.status).toBe(0);
    expect(accepted.output).not.toContain('prefer-node-protocol');
  });

  it('rejects a console call in application code and accepts the CLI exception', () => {
    const rejected = lintFixture(
      `export function report(message: string): void {
  console.log(message);
}
`,
      {
        ...CONFIG_IN_FIXTURE,
        fileName: 'src/modules/probe/application/probe.ts',
      },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('eslint(no-console)');

    const accepted = lintFixture(
      `export function report(message: string): void {
  console.log(message);
}
`,
      { ...CONFIG_IN_FIXTURE, fileName: 'src/cli/probe.ts' },
    );
    expect(accepted.status).toBe(0);
    expect(accepted.output).not.toContain('no-console');
  });
});
