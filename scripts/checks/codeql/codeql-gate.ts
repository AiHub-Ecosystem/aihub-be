import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const TRIAGE_FILE = '.github/codeql/triage.json';

export interface SarifResult {
  readonly ruleId?: string;
  readonly message?: { readonly text?: string };
  readonly locations?: readonly {
    readonly physicalLocation?: {
      readonly artifactLocation?: { readonly uri?: string };
      readonly region?: { readonly startLine?: number };
    };
  }[];
  readonly suppressions?: readonly { readonly kind: string }[];
  readonly partialFingerprints?: { readonly primaryLocationLineHash?: string };
}

export interface Sarif {
  readonly runs?: readonly { readonly results?: readonly SarifResult[] }[];
}

export interface TriageEntry {
  readonly ruleId: string;
  readonly path: string;
  /** The scanner's stable id for one alert (`primaryLocationLineHash`). */
  readonly fingerprint: string;
  readonly reason: string;
}

export interface Triage {
  readonly entries: readonly TriageEntry[];
}

export interface Finding {
  readonly ruleId: string;
  readonly path: string;
  readonly line: number | undefined;
  readonly fingerprint: string | undefined;
  readonly message: string;
}

export interface GateOutcome {
  readonly untriaged: readonly Finding[];
  readonly stale: readonly TriageEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A triage entry waives one alert, named by its fingerprint, and must say why. */
export function parseTriage(text: string): Triage {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) {
    throw new Error(`${TRIAGE_FILE} needs an "entries" array`);
  }
  const entries = parsed['entries'].map((entry: unknown): TriageEntry => {
    if (
      !isRecord(entry) ||
      typeof entry['ruleId'] !== 'string' ||
      typeof entry['path'] !== 'string'
    ) {
      throw new Error(`${TRIAGE_FILE} entry needs a ruleId and a path`);
    }
    if (
      typeof entry['fingerprint'] !== 'string' ||
      entry['fingerprint'] === ''
    ) {
      throw new Error(
        `${TRIAGE_FILE} entry ${entry['ruleId']} at ${entry['path']} needs a fingerprint`,
      );
    }
    if (typeof entry['reason'] !== 'string' || entry['reason'].trim() === '') {
      throw new Error(
        `${TRIAGE_FILE} entry ${entry['ruleId']} at ${entry['path']} needs a reason`,
      );
    }
    return {
      ruleId: entry['ruleId'],
      path: entry['path'],
      fingerprint: entry['fingerprint'],
      reason: entry['reason'],
    };
  });
  return { entries };
}

function findings(sarif: Sarif): { finding: Finding; suppressed: boolean }[] {
  return (sarif.runs ?? []).flatMap((run) =>
    (run.results ?? []).map((result) => {
      const location = result.locations?.[0]?.physicalLocation;
      return {
        suppressed: (result.suppressions?.length ?? 0) > 0,
        finding: {
          ruleId: result.ruleId ?? 'unknown',
          path: location?.artifactLocation?.uri ?? 'unknown',
          line: location?.region?.startLine,
          fingerprint: result.partialFingerprints?.primaryLocationLineHash,
          message: result.message?.text ?? '',
        },
      };
    }),
  );
}

/**
 * A finding passes when the scanner marks it suppressed or the manifest
 * triages that one alert: same rule, path and fingerprint. A second alert of
 * the same rule in the same file, or the same alert after its line changes,
 * is new and fails the job.
 */
export function evaluateSarif(sarif: Sarif, triage: Triage): GateOutcome {
  const all = findings(sarif);
  const matches = (entry: TriageEntry, finding: Finding): boolean =>
    entry.ruleId === finding.ruleId &&
    entry.path === finding.path &&
    entry.fingerprint === finding.fingerprint;
  return {
    untriaged: all
      .filter(
        ({ finding, suppressed }) =>
          !suppressed &&
          !triage.entries.some((entry) => matches(entry, finding)),
      )
      .map(({ finding }) => finding),
    stale: triage.entries.filter(
      (entry) => !all.some(({ finding }) => matches(entry, finding)),
    ),
  };
}

/** A SARIF file without a run means the scan did not happen; never pass it. */
export function parseRuns(
  text: string,
  file: string,
): NonNullable<Sarif['runs']> {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed['runs']) ||
    parsed['runs'].length === 0
  ) {
    throw new Error(
      `${file} has no SARIF runs; the scan did not produce results`,
    );
  }
  return parsed['runs'] as NonNullable<Sarif['runs']>;
}

function readRuns(file: string): NonNullable<Sarif['runs']> {
  return parseRuns(readFileSync(file, 'utf8'), file);
}

function main(sarifPaths: readonly string[]): void {
  if (sarifPaths.length === 0) {
    throw new Error('usage: codeql-gate <results.sarif>...');
  }
  const triage = parseTriage(
    readFileSync(path.join(ROOT, TRIAGE_FILE), 'utf8'),
  );
  const runs = sarifPaths.flatMap((file) => readRuns(file));
  const outcome = evaluateSarif({ runs }, triage);

  for (const entry of outcome.stale) {
    console.warn(
      `codeql-gate: triage entry ${entry.ruleId} at ${entry.path} (${entry.fingerprint}) matches no finding; remove it from ${TRIAGE_FILE}`,
    );
  }
  for (const finding of outcome.untriaged) {
    console.error(
      `codeql-gate: ${finding.ruleId} ${finding.path}:${finding.line ?? '?'} fingerprint=${finding.fingerprint ?? 'none'} ${finding.message}`,
    );
  }
  if (outcome.untriaged.length > 0) {
    console.error(
      `codeql-gate: ${outcome.untriaged.length} untriaged finding(s). Fix them, or add an entry with the finding's rule, path, fingerprint and a reason to ${TRIAGE_FILE}.`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
