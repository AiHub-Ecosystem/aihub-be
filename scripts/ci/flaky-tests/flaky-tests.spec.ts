import flakyTests from './flaky-tests.cjs';

const {
  createFlakyReport,
  formatFlakyComment,
  parseJUnitReport,
  runWithRetries,
} = flakyTests;

const firstRun = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="scripts/a.spec.ts" file="scripts/a.spec.ts" failures="1">
    <testsuite name="service behavior">
      <testcase name="retries &amp; passes" classname="service behavior" file="scripts/a.spec.ts" line="7" time="0.020">
        <failure message="first attempt failed">details</failure>
      </testcase>
      <testcase name="stays green" classname="service behavior" file="scripts/a.spec.ts" line="12" time="0.010" />
    </testsuite>
  </testsuite>
</testsuites>`;

const retryRun = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="scripts/a.spec.ts" file="scripts/a.spec.ts" failures="0">
    <testsuite name="service behavior">
      <testcase name="retries &amp; passes" classname="service behavior" file="scripts/a.spec.ts" line="7" time="0.030" />
      <testcase name="stays green" classname="service behavior" file="scripts/a.spec.ts" line="12" time="0.010" />
    </testsuite>
  </testsuite>
</testsuites>`;

describe('flaky test reporting', () => {
  it('parses failed cases and their files from nested JUnit output', () => {
    const result = parseJUnitReport(firstRun);

    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toMatchObject({
      file: 'scripts/a.spec.ts',
      name: 'retries & passes',
      status: 'failed',
      durationMs: 20,
    });
    expect(result.failedFiles).toEqual(['scripts/a.spec.ts']);
  });

  it('retries only failed files and stops when they pass', () => {
    const calls: { attempt: number; files: string[] | null }[] = [];
    const attempts = runWithRetries(({ attempt, files }) => {
      calls.push({ attempt, files });
      return {
        exitCode: attempt === 1 ? 1 : 0,
        failedFiles: attempt === 1 ? ['scripts/a.spec.ts'] : [],
      };
    }, 2);

    expect(calls).toEqual([
      { attempt: 1, files: null },
      { attempt: 2, files: ['scripts/a.spec.ts'] },
    ]);
    expect(attempts).toHaveLength(2);
  });

  it("records a flaky case from a stub command's failed and passing JUnit reports", () => {
    const calls: { attempt: number; files: string[] | null }[] = [];
    const attempts = runWithRetries(({ attempt, files }) => {
      calls.push({ attempt, files });
      return {
        exitCode: attempt === 1 ? 1 : 0,
        ...parseJUnitReport(attempt === 1 ? firstRun : retryRun),
      };
    }, 2);
    const { report } = createFlakyReport(attempts, {
      generatedAt: '2026-11-11T00:00:00.000Z',
    });

    expect(calls).toEqual([
      { attempt: 1, files: null },
      { attempt: 2, files: ['scripts/a.spec.ts'] },
    ]);
    expect(report.flakyTests.map(({ name }) => name)).toEqual([
      'retries & passes',
    ]);
  });

  it('stops at the configured attempt limit when a file keeps failing', () => {
    const attempts = runWithRetries(
      () => ({ exitCode: 1, failedFiles: ['scripts/a.spec.ts'] }),
      2,
    );

    expect(attempts).toHaveLength(3);
    expect(attempts.at(-1)?.exitCode).toBe(1);
  });

  it('tracks a failure followed by a pass, duration, and historical rate', () => {
    const attempts = [
      { exitCode: 1, ...parseJUnitReport(firstRun) },
      { exitCode: 0, ...parseJUnitReport(retryRun) },
    ];
    const { report, history } = createFlakyReport(attempts, {
      generatedAt: '2026-11-11T00:00:00.000Z',
      threshold: 0.05,
      history: {
        schemaVersion: 1,
        runs: [
          {
            at: '2026-11-10T00:00:00.000Z',
            tests: 100,
            flakes: 6,
            attempts: 1,
          },
        ],
        tests: {},
      },
    });
    const flaky = report.flakyTests[0];

    expect(report).toMatchObject({
      status: 'passed',
      attempts: 2,
      testCount: 2,
      flakyCount: 1,
      alert: true,
    });
    expect(flaky).toMatchObject({
      name: 'retries & passes',
      flakyRuns: 1,
      runs: 1,
      averageDurationMs: 25,
    });
    expect(history.runs).toHaveLength(2);
  });

  it('keeps exempt tests running while excluding their flakes from the alert rate', () => {
    const { report, history } = createFlakyReport(
      [
        { exitCode: 1, ...parseJUnitReport(firstRun) },
        { exitCode: 0, ...parseJUnitReport(retryRun) },
      ],
      {
        generatedAt: '2026-11-11T00:00:00.000Z',
        threshold: 0.05,
        exemptions: [
          {
            file: 'scripts/a.spec.ts',
            name: 'retries & passes',
            reason: 'Awaiting upstream deterministic fixture fix.',
          },
        ],
      },
    );

    expect(report).toMatchObject({
      testCount: 1,
      flakyCount: 0,
      exemptFlakyCount: 1,
      alert: false,
    });
    expect(
      Object.values(history.tests).some((testCase) => testCase.flakyRuns === 1),
    ).toBe(true);
  });

  it('renders an alert and escapes test-controlled Markdown', () => {
    const { report } = createFlakyReport(
      [
        {
          exitCode: 1,
          cases: [
            {
              id: 'hostile',
              file: 'scripts/a.spec.ts',
              className: 'suite',
              line: '5',
              name: '@team `| <script>',
              durationMs: 10,
              status: 'failed',
            },
          ],
          failedFiles: ['scripts/a.spec.ts'],
        },
        {
          exitCode: 0,
          cases: [
            {
              id: 'hostile',
              file: 'scripts/a.spec.ts',
              className: 'suite',
              line: '5',
              name: '@team `| <script>',
              durationMs: 10,
              status: 'passed',
            },
          ],
          failedFiles: [],
        },
      ],
      { generatedAt: '2026-11-11T00:00:00.000Z', threshold: 0.1 },
    );
    const comment = formatFlakyComment(report);

    expect(comment).toContain('⚠️');
    expect(comment).toContain('@\u200bteam');
    expect(comment).not.toContain('<script>');
  });
});
