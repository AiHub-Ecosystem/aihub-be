import mergedCoverage from './merged-coverage.cjs';

const {
  DEFAULT_MARGIN_POINTS,
  branchPercent,
  compareCoverage,
  isProductionCode,
  parseCoverageReport,
} = mergedCoverage;

describe('branchPercent', () => {
  it('is null for a metric no lane produced, rather than a misleading zero', () => {
    expect(branchPercent({ branches: { total: 0, covered: 0 } })).toBeNull();
  });

  it('reads covered over total', () => {
    expect(branchPercent({ branches: { total: 4, covered: 1 } })).toBe(25);
  });
});

describe('isProductionCode', () => {
  it('keeps production sources', () => {
    expect(
      isProductionCode('src/modules/gateway/application/quota-period.ts'),
    ).toBe(true);
  });

  // The unit lane collects every file under src, so without this the totals
  // would be one number counting spec files and another not.
  it('drops spec files', () => {
    expect(
      isProductionCode('src/modules/gateway/application/quota-period.spec.ts'),
    ).toBe(false);
  });

  it('drops the in-memory test doubles under testing/', () => {
    expect(
      isProductionCode(
        'src/modules/auth/testing/in-memory-user-account.adapter.ts',
      ),
    ).toBe(false);
    expect(isProductionCode('src/modules/auth/testing')).toBe(false);
  });
});

describe('compareCoverage', () => {
  const baseline = {
    lines: 80,
    branches: 70,
    statements: 80,
    functions: 80,
  };

  it('passes when coverage holds', () => {
    const result = compareCoverage(baseline, baseline);

    expect(result.ok).toBe(true);
    expect(result.marginPoints).toBe(DEFAULT_MARGIN_POINTS);
  });

  it('passes when coverage rises', () => {
    const result = compareCoverage(baseline, { ...baseline, branches: 72 });

    expect(result.ok).toBe(true);
    expect(result.findings.find((f) => f.metric === 'branches')?.status).toBe(
      'ok',
    );
  });

  // Half a point is deliberate: it is above the noise a single added test file
  // produces, and below the drop that removing a suite's coverage would cause.
  it('fails a drop larger than the margin', () => {
    const result = compareCoverage(baseline, { ...baseline, branches: 69 });

    expect(result.ok).toBe(false);
    expect(result.findings.find((f) => f.metric === 'branches')).toMatchObject({
      status: 'drop',
      delta: -1,
    });
  });

  it('tolerates a drop inside the margin', () => {
    const result = compareCoverage(baseline, { ...baseline, branches: 69.8 });

    expect(result.ok).toBe(true);
  });

  it('judges each metric on its own, so a rise does not offset a drop', () => {
    const result = compareCoverage(baseline, {
      ...baseline,
      branches: 60,
      lines: 95,
    });

    expect(result.ok).toBe(false);
    expect(result.findings.find((f) => f.metric === 'lines')?.status).toBe(
      'ok',
    );
    expect(result.findings.find((f) => f.metric === 'branches')?.status).toBe(
      'drop',
    );
  });

  it('reports a metric the baseline never recorded instead of assuming it held', () => {
    const result = compareCoverage(
      { branches: 70 },
      { branches: 70, lines: 80 },
    );

    expect(result.ok).toBe(true);
    expect(result.findings.find((f) => f.metric === 'lines')?.status).toBe(
      'unknown',
    );
  });

  it('fails with no baseline at all rather than passing silently', () => {
    const result = compareCoverage(undefined, baseline);

    expect(result.ok).toBe(false);
    expect(result.findings.every((f) => f.status === 'unknown')).toBe(true);
  });
});

describe('parseCoverageReport', () => {
  it('keeps recorded metrics and rejects invalid baseline values', () => {
    expect(parseCoverageReport({ branches: 70 })).toEqual({
      lines: undefined,
      branches: 70,
      statements: undefined,
      functions: undefined,
    });
    expect(() => parseCoverageReport({ branches: '70' })).toThrow(
      'coverage baseline branches must be a finite number',
    );
  });
});
