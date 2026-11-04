import {
  type Sarif,
  type SarifResult,
  type Triage,
  evaluateSarif,
  parseRuns,
  parseTriage,
} from './codeql-gate';

function result(
  ruleId: string,
  uri: string,
  suppressions?: readonly { kind: string }[],
): readonly SarifResult[] {
  return [
    {
      ruleId,
      message: { text: 'finding' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine: 3 },
          },
        },
      ],
      ...(suppressions === undefined ? {} : { suppressions }),
    },
  ];
}

const NO_TRIAGE: Triage = { entries: [] };

describe('codeql gate', () => {
  it('fails on a finding nobody triaged', () => {
    const sarif: Sarif = {
      runs: [{ results: result('aihub/request-data-to-raw-sql', 'src/a.ts') }],
    };

    const outcome = evaluateSarif(sarif, NO_TRIAGE);

    expect(outcome.untriaged.map((item) => item.path)).toEqual(['src/a.ts']);
  });

  it('passes a finding the manifest triages for that rule and path', () => {
    const sarif: Sarif = {
      runs: [{ results: result('aihub/request-data-to-raw-sql', 'src/a.ts') }],
    };
    const triage: Triage = {
      entries: [
        {
          ruleId: 'aihub/request-data-to-raw-sql',
          path: 'src/a.ts',
          reason: 'identifier comes from a reviewed allowlist',
        },
      ],
    };

    expect(evaluateSarif(sarif, triage).untriaged).toEqual([]);
  });

  it('does not let a triage entry for one path cover another', () => {
    const sarif: Sarif = {
      runs: [{ results: result('aihub/request-data-to-raw-sql', 'src/b.ts') }],
    };
    const triage: Triage = {
      entries: [
        {
          ruleId: 'aihub/request-data-to-raw-sql',
          path: 'src/a.ts',
          reason: 'reviewed',
        },
      ],
    };

    expect(evaluateSarif(sarif, triage).untriaged).toHaveLength(1);
  });

  it('passes a finding the scanner reports as suppressed', () => {
    const sarif: Sarif = {
      runs: [
        {
          results: result('js/redos', 'src/a.ts', [{ kind: 'inSource' }]),
        },
      ],
    };

    expect(evaluateSarif(sarif, NO_TRIAGE).untriaged).toEqual([]);
  });

  it('reports triage entries that no longer match a finding', () => {
    const triage: Triage = {
      entries: [{ ruleId: 'js/redos', path: 'src/gone.ts', reason: 'old' }],
    };

    expect(evaluateSarif({ runs: [{ results: [] }] }, triage).stale).toEqual(
      triage.entries,
    );
  });

  it('refuses a SARIF file that holds no run', () => {
    expect(() => parseRuns('{"runs":[]}', 'x.sarif')).toThrow('no SARIF runs');
    expect(() => parseRuns('{}', 'x.sarif')).toThrow('no SARIF runs');
  });

  it('rejects a manifest entry without a reason', () => {
    expect(() =>
      parseTriage('{"entries":[{"ruleId":"js/redos","path":"src/a.ts"}]}'),
    ).toThrow('reason');
  });
});
