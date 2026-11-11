import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import flakyTests from './flaky-tests.cjs';

const { formatFlakyComment } = flakyTests;

const reportPath =
  process.env.AIHUB_FLAKY_REPORT_PATH ?? 'temp/flaky-test-report/report.json';
const repository = process.env.GITHUB_REPOSITORY ?? '';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string[]} args */
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'GitHub CLI request failed');
  }
  return result.stdout.trim();
}

if (!existsSync(reportPath)) {
  console.log('flaky tests: no report artifact; skipping PR comment');
  process.exit(0);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must be owner/name');
}

const parsedPullRequests = /** @type {unknown} */ (
  JSON.parse(process.env.AIHUB_FLAKY_PR_NUMBERS ?? '[]')
);
const pullRequests = Array.isArray(parsedPullRequests)
  ? parsedPullRequests.filter(
      (value) => typeof value === 'number' || typeof value === 'string',
    )
  : [];
const parsedReport = /** @type {unknown} */ (
  JSON.parse(readFileSync(reportPath, 'utf8'))
);
if (
  !isRecord(parsedReport) ||
  parsedReport.schemaVersion !== 1 ||
  !Array.isArray(parsedReport.flakyTests) ||
  !Array.isArray(parsedReport.failedTests) ||
  !Array.isArray(parsedReport.slowestTests)
) {
  console.log(
    'flaky tests: report artifact has an unknown schema; skipping PR comment',
  );
  process.exit(0);
}
const report = /** @type {Parameters<typeof formatFlakyComment>[0]} */ (
  parsedReport
);
const body = formatFlakyComment(report);
for (const value of new Set(pullRequests)) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) continue;

  const matches = gh([
    'api',
    '--paginate',
    `repos/${repository}/issues/${number}/comments`,
    '--jq',
    '.[] | select(.body | contains("<!-- aihub-flaky-tests -->")) | .id',
  ]);
  const commentId = matches.split(/\s+/).filter(Boolean).at(-1);
  const args = commentId
    ? [
        'api',
        `repos/${repository}/issues/comments/${commentId}`,
        '--method',
        'PATCH',
      ]
    : [
        'api',
        `repos/${repository}/issues/${number}/comments`,
        '--method',
        'POST',
      ];
  gh([...args, '-f', `body=${body}`]);
  console.log(`flaky tests: updated PR #${number}`);
}
