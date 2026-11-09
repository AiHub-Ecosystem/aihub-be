/**
 * The gate for the scheduled active DAST scan (issue #319): an alert from an
 * injection-class rule fails the run.
 *
 *   node --import tsx scripts/ci/dast/dast-gate.ts <zap-results.sarif>
 *
 * Matches the SARIF rule ids in `DAST_FAILING_RULE_IDS` and, as a fallback
 * against rule-id drift, the rule names in `DAST_FAILING_RULE_NAMES`. Every
 * other finding is report-only: the Security tab and the workflow artifact
 * carry them, and the runbook's triage flow decides what becomes an issue.
 */

import { readFileSync } from 'node:fs';

import {
  DAST_FAILING_RULE_IDS,
  DAST_FAILING_RULE_NAMES,
} from '../../../ops/dast/zap-rules';

interface SarifResult {
  readonly ruleId?: string;
  readonly message?: { readonly text?: string };
}

interface SarifRun {
  readonly results?: readonly SarifResult[];
  readonly tool?: {
    readonly driver?: {
      readonly rules?: readonly {
        readonly id: string;
        readonly name?: string;
      }[];
    };
  };
}

function failingReason(
  ruleId: string | undefined,
  ruleName: string | undefined,
): string | undefined {
  if (ruleId === undefined) return undefined;
  const id = Number.parseInt(ruleId, 10);
  if (Number.isFinite(id) && DAST_FAILING_RULE_IDS.includes(id)) {
    return `rule id ${ruleId}${ruleName === undefined ? '' : ` (${ruleName})`}`;
  }
  if (
    ruleName !== undefined &&
    DAST_FAILING_RULE_NAMES.some((pattern) => pattern.test(ruleName))
  ) {
    return `rule name ${ruleName} (id ${ruleId})`;
  }
  return undefined;
}

const sarifPath = process.argv[2];
if (sarifPath === undefined || sarifPath.length === 0) {
  console.error(
    'usage: node --import tsx scripts/ci/dast/dast-gate.ts <sarif>',
  );
  process.exit(2);
}

const sarif = JSON.parse(readFileSync(sarifPath, 'utf8')) as {
  readonly runs?: readonly SarifRun[];
};

const ruleNames = new Map<string, string>();
for (const rule of sarif.runs?.[0]?.tool?.driver?.rules ?? []) {
  ruleNames.set(rule.id, rule.name ?? rule.id);
}

const violations: string[] = [];
let resultCount = 0;
for (const run of sarif.runs ?? []) {
  for (const result of run.results ?? []) {
    resultCount += 1;
    const reason = failingReason(
      result.ruleId,
      result.ruleId === undefined ? undefined : ruleNames.get(result.ruleId),
    );
    if (reason !== undefined) {
      violations.push(`${reason}: ${result.message?.text ?? 'no message'}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `dast-gate: ${violations.length} injection-class finding(s) failed the active scan:`,
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(
  `dast-gate: no injection-class findings across ${resultCount} result(s)`,
);
