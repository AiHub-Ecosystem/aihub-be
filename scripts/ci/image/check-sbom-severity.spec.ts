import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const { countFindingsAtOrAbove, parseArgs, severityRank } =
  require('./check-sbom-severity.cjs') as {
    countFindingsAtOrAbove: (
      r: unknown,
      cutoff?: string,
    ) => { total: number; bySeverity: Record<string, number> };
    parseArgs: (argv: string[]) => { file: string; threshold: string };
    severityRank: (severity: string | undefined) => number;
  };

function reportWith(severities: string[]) {
  return {
    matches: severities.map((severity) => ({
      vulnerability: { severity },
      artifact: { name: 'pkg', version: '1.0.0' },
    })),
  };
}

describe('check-sbom-severity.cjs', () => {
  it('counts findings at or above high', () => {
    const { total, bySeverity } = countFindingsAtOrAbove(
      reportWith(['low', 'medium', 'high', 'critical', 'HIGH']),
      'high',
    );
    expect(total).toBe(3);
    expect(bySeverity).toEqual({ high: 2, critical: 1 });
  });

  it('defaults to high', () => {
    expect(countFindingsAtOrAbove(reportWith(['critical'])).total).toBe(1);
  });

  it('rejects unknown cutoffs and handles empty reports', () => {
    expect(countFindingsAtOrAbove({}, 'high')).toEqual({
      total: 0,
      bySeverity: {},
    });
    expect(() => countFindingsAtOrAbove(reportWith(['high']), 'bogus')).toThrow(
      /unknown severity/,
    );
    expect(severityRank('unknown')).toBe(-1);
  });

  it('parses args and keeps the entry point', () => {
    expect(parseArgs(['sbom.json'])).toEqual({
      file: 'sbom.json',
      threshold: 'high',
    });
    expect(parseArgs(['sbom.json', '--threshold', 'critical'])).toEqual({
      file: 'sbom.json',
      threshold: 'critical',
    });
    expect(() => parseArgs([])).toThrow(/usage/);
    const scriptPath = path.resolve('scripts/ci/image/check-sbom-severity.cjs');
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, 'utf8')).toContain('require.main');
  });
});
