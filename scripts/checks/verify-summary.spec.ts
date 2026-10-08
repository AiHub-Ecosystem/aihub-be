import { logFileName, summarize } from './verify-summary.cjs';

const ESC = String.fromCharCode(27);

const PASSING = [
  '$ pnpm knip && pnpm lint && pnpm test',
  '$ node scripts/checks/knip.mjs',
  '$ jest',
  `${ESC}[32mPASS${ESC}[39m src/a.spec.ts`,
  'Test Suites: 172 passed, 172 total',
  'Tests:       1657 passed, 1657 total',
  '$ node scripts/checks/check-architecture.mjs',
  'x 14 dependency violations (0 errors, 14 warnings). 476 modules.',
  '$ node scripts/checks/validate-openapi.mjs',
  'openapi.json is valid OpenAPI 3.1',
].join('\n');

describe('summarize', () => {
  it('reports a passing run in a few lines', () => {
    const text = summarize(PASSING, 0, '/tmp/v.log');

    expect(text.split('\n')[0]).toBe('verify: PASS');
    expect(text).toContain('Test Suites: 172 passed, 172 total');
    expect(text).toContain('Tests:       1657 passed, 1657 total');
    expect(text).toContain('0 errors, 14 warnings');
    expect(text).toContain('OpenAPI valid');
    expect(text).toContain('full log: /tmp/v.log');
    expect(text.split('\n').length).toBeLessThan(10);
  });

  it('reads the last Jest summary when a log holds two runs', () => {
    const log = `${PASSING}\nTest Suites: 2 failed, 170 passed, 172 total\nTests:       13 failed, 1644 passed, 1657 total`;

    const text = summarize(log, 0, '/tmp/v.log');

    expect(text).toContain('Test Suites: 2 failed, 170 passed, 172 total');
    expect(text).not.toContain('172 passed, 172 total');
  });

  it('names the step that failed and quotes what it printed', () => {
    const log = [
      '$ pnpm knip && pnpm lint',
      '$ node scripts/checks/knip.mjs',
      '$ oxlint . && biome check .',
      `src/a.spec.ts:25:5: ${ESC}[31merror${ESC}[39m jest(no-conditional-expect): Unexpected conditional expect`,
      '[ELIFECYCLE] Command failed with exit code 1.',
      '[ELIFECYCLE] Command failed with exit code 1.',
    ].join('\n');

    const text = summarize(log, 1, '/tmp/v.log');

    expect(text.split('\n')[0]).toBe('verify: FAIL (exit 1)');
    expect(text).toContain('failed step: oxlint . && biome check .');
    expect(text).toContain(
      'src/a.spec.ts:25:5: error jest(no-conditional-expect)',
    );
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('ELIFECYCLE');
  });

  it('lists failing Jest files and tests instead of the whole step', () => {
    const log = [
      '$ jest',
      'FAIL scripts/checks/check-architecture.spec.ts (6.953 s)',
      '  ● cross-module import rule › reports the 10 cross-module imports',
      '    SyntaxError: Unexpected end of JSON input',
      'FAIL test/cli/cli-loader.spec.ts',
      '  ● cli loader › loads a built runner',
      'Test Suites: 2 failed, 170 passed, 172 total',
      'Tests:       13 failed, 1644 passed, 1657 total',
      '[ELIFECYCLE] Command failed with exit code 1.',
    ].join('\n');

    const text = summarize(log, 1, '/tmp/v.log');

    expect(text).toContain('FAIL scripts/checks/check-architecture.spec.ts');
    expect(text).toContain('FAIL test/cli/cli-loader.spec.ts');
    expect(text).toContain(
      '● cross-module import rule › reports the 10 cross-module imports',
    );
    expect(text).not.toContain('SyntaxError');
  });

  it('caps what it quotes from a failing step', () => {
    const noisy = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const log = ['$ tsc --noEmit', ...noisy, '[ELIFECYCLE] failed'].join('\n');

    const text = summarize(log, 1, '/tmp/v.log');

    expect(text.split('\n').length).toBeLessThan(40);
    expect(text).toContain('line 0');
    expect(text).not.toContain('line 199');
  });

  it('quotes the end of the log when it names no step', () => {
    const log = [
      '<--- Last few GCs --->',
      '',
      'FATAL ERROR: Allocation failed - JavaScript heap out of memory',
      ' 1: 00007FF7E28F4BB7',
    ].join('\n');

    const text = summarize(log, 134, '/tmp/v.log');

    expect(text.split('\n')[0]).toBe('verify: FAIL (exit 134)');
    expect(text).toContain(
      'FATAL ERROR: Allocation failed - JavaScript heap out of memory',
    );
    expect(text).toContain('full log: /tmp/v.log');
  });
});

describe('logFileName', () => {
  it('gives every run its own file, so one run never overwrites another', () => {
    const first = logFileName(new Date('2026-10-02T16:00:00.000Z'));
    const second = logFileName(new Date('2026-10-02T16:00:01.000Z'));

    expect(first).toBe('verify-20261002T160000Z.log');
    expect(second).not.toBe(first);
  });
});
