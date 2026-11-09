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
  options: {
    readonly fingerprint?: string;
    readonly suppressions?: readonly { kind: string }[];
  } = {},
): SarifResult {
  return {
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
    ...(options.fingerprint === undefined
      ? {}
      : {
          partialFingerprints: { primaryLocationLineHash: options.fingerprint },
        }),
    ...(options.suppressions === undefined
      ? {}
      : { suppressions: options.suppressions }),
  };
}

function sarifOf(...results: SarifResult[]): Sarif {
  return { runs: [{ results }] };
}

const NO_TRIAGE: Triage = { entries: [] };
const SQL = 'aihub/request-data-to-raw-sql';

describe('codeql gate', () => {
  it('fails on a finding nobody triaged', () => {
    const outcome = evaluateSarif(
      sarifOf(result(SQL, 'src/a.ts', { fingerprint: 'h1:1' })),
      NO_TRIAGE,
    );

    expect(outcome.untriaged.map((item) => item.path)).toEqual(['src/a.ts']);
  });

  it('passes the alert the manifest triages by fingerprint', () => {
    const triage: Triage = {
      entries: [
        {
          ruleId: SQL,
          path: 'src/a.ts',
          fingerprint: 'h1:1',
          reason: 'identifier comes from a reviewed allowlist',
        },
      ],
    };

    const outcome = evaluateSarif(
      sarifOf(result(SQL, 'src/a.ts', { fingerprint: 'h1:1' })),
      triage,
    );

    expect(outcome.untriaged).toEqual([]);
  });

  it('fails a second alert of the same rule in a triaged file', () => {
    const triage: Triage = {
      entries: [
        { ruleId: SQL, path: 'src/a.ts', fingerprint: 'h1:1', reason: 'ok' },
      ],
    };

    const outcome = evaluateSarif(
      sarifOf(
        result(SQL, 'src/a.ts', { fingerprint: 'h1:1' }),
        result(SQL, 'src/a.ts', { fingerprint: 'h2:1' }),
      ),
      triage,
    );

    expect(outcome.untriaged.map((item) => item.fingerprint)).toEqual(['h2:1']);
  });

  it('does not let a triage entry for one path cover another', () => {
    const triage: Triage = {
      entries: [
        { ruleId: SQL, path: 'src/a.ts', fingerprint: 'h1:1', reason: 'ok' },
      ],
    };

    const outcome = evaluateSarif(
      sarifOf(result(SQL, 'src/b.ts', { fingerprint: 'h1:1' })),
      triage,
    );

    expect(outcome.untriaged).toHaveLength(1);
  });

  it('fails a finding that carries no fingerprint', () => {
    const triage: Triage = {
      entries: [
        { ruleId: SQL, path: 'src/a.ts', fingerprint: 'h1:1', reason: 'ok' },
      ],
    };

    expect(
      evaluateSarif(sarifOf(result(SQL, 'src/a.ts')), triage).untriaged,
    ).toHaveLength(1);
  });

  it('passes a finding the scanner reports as suppressed', () => {
    const outcome = evaluateSarif(
      sarifOf(
        result('js/redos', 'src/a.ts', {
          suppressions: [{ kind: 'inSource' }],
        }),
      ),
      NO_TRIAGE,
    );

    expect(outcome.untriaged).toEqual([]);
  });

  it('reports triage entries that no longer match a finding', () => {
    const triage: Triage = {
      entries: [
        {
          ruleId: 'js/redos',
          path: 'src/gone.ts',
          fingerprint: 'h9:1',
          reason: 'old',
        },
      ],
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
      parseTriage(
        '{"entries":[{"ruleId":"js/redos","path":"src/a.ts","fingerprint":"h:1"}]}',
      ),
    ).toThrow('reason');
  });

  it('rejects a manifest entry without a fingerprint', () => {
    expect(() =>
      parseTriage(
        '{"entries":[{"ruleId":"js/redos","path":"src/a.ts","reason":"ok"}]}',
      ),
    ).toThrow('fingerprint');
  });
});
