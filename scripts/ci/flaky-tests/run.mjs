import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { buildBunTestArgs } from '../../cli/run-bun-test.mjs';
import flakyTests from './flaky-tests.cjs';

const {
  createFlakyReport,
  formatFlakyComment,
  parseJUnitReport,
  runWithRetries,
} = flakyTests;

/**
 * @typedef {{file: string, name: string, reason: string, className?: string}} FlakyExemption
 * @typedef {{file: string, name: string, className: string, line: string, runs: number, flakyRuns: number, durationsMs: number[], lastSeenAt: string, exempt: boolean}} FlakyTestHistory
 * @typedef {{at: string, tests: number, flakes: number, attempts: number}} FlakyRunHistory
 * @typedef {{schemaVersion: 1, runs: FlakyRunHistory[], tests: Record<string, FlakyTestHistory>}} FlakyHistory
 */

const outputDir = resolve(
  process.env.AIHUB_FLAKY_OUTPUT_DIR ?? 'temp/flaky-tests',
);
const reportPath = resolve(outputDir, 'report.json');
const historyPath = resolve(
  process.env.AIHUB_FLAKY_HISTORY_PATH ?? `${outputDir}/history.json`,
);
const retries = Number(process.env.AIHUB_FLAKY_TEST_RETRIES ?? 2);
const threshold = Number(process.env.AIHUB_FLAKY_RATE_THRESHOLD ?? 0.05);
const generatedAt = new Date().toISOString();
const exemptionsPath = new URL('./exemptions.json', import.meta.url);
const exemptions = loadExemptions();
const previousHistory = loadHistory();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {FlakyExemption[]} */
function loadExemptions() {
  const parsed = /** @type {unknown} */ (
    JSON.parse(readFileSync(exemptionsPath, 'utf8'))
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.exemptions)) {
    throw new TypeError('exemptions.json must contain an exemptions array');
  }
  const exemptionValues = /** @type {unknown[]} */ (parsed.exemptions);
  const exemptions = exemptionValues.map((value) => {
    if (!isRecord(value)) {
      throw new TypeError('each flaky test exemption must be an object');
    }
    const { file, name, reason, className } = value;
    if (
      typeof file !== 'string' ||
      typeof name !== 'string' ||
      typeof reason !== 'string' ||
      !file.trim() ||
      !name.trim() ||
      !reason.trim() ||
      (className !== undefined && typeof className !== 'string')
    ) {
      throw new TypeError(
        'each flaky test exemption needs a file, exact test name, and reason',
      );
    }
    return {
      file,
      name,
      reason,
      ...(typeof className === 'string' ? { className } : {}),
    };
  });
  return exemptions;
}

/** @returns {FlakyHistory} */
function loadHistory() {
  try {
    const parsed = /** @type {unknown} */ (
      JSON.parse(readFileSync(historyPath, 'utf8'))
    );
    if (
      isRecord(parsed) &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.runs) &&
      isRecord(parsed.tests)
    ) {
      return /** @type {FlakyHistory} */ (parsed);
    }
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    ) {
      console.warn(
        `flaky tests: starting a fresh history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return /** @type {FlakyHistory} */ ({
    schemaVersion: 1,
    runs: [],
    tests: {},
  });
}

const originalArgs = process.argv.slice(2);
const attempts = runWithRetries(({ attempt, files }) => {
  const junitPath = resolve(outputDir, `attempt-${attempt}.xml`);
  mkdirSync(outputDir, { recursive: true });
  rmSync(junitPath, { force: true });
  const testArgs = buildBunTestArgs(files ?? originalArgs);
  testArgs.push('--reporter=junit', `--reporter-outfile=${junitPath}`);
  const result = spawnSync('bun', testArgs, { stdio: 'inherit' });
  /** @type {ReturnType<typeof parseJUnitReport>} */
  let parsed = { cases: [], failedFiles: [] };
  /** @type {string | undefined} */
  let reportError;
  try {
    parsed = parseJUnitReport(readFileSync(junitPath, 'utf8'));
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(junitPath, { force: true });
  }
  if (result.error) console.error(result.error.message);
  return {
    exitCode: result.status ?? 1,
    ...parsed,
    ...(reportError ? { reportError } : {}),
  };
}, retries);

const { report, history } = createFlakyReport(attempts, {
  generatedAt,
  threshold,
  exemptions,
  history: previousHistory,
});
mkdirSync(outputDir, { recursive: true });
mkdirSync(dirname(historyPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);

const summary = formatFlakyComment(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
}
if (report.alert) {
  console.log(
    `::warning::Flaky test rate ${Math.round(report.recentFlakeRate * 10000) / 100}% exceeds ${Math.round(threshold * 10000) / 100}%.`,
  );
}
process.exitCode = report.status === 'passed' ? 0 : 1;
