#!/usr/bin/env node
/**
 * Issue-triage metadata check.
 *
 * Fails when an OPEN issue in the tracker is missing required triage metadata,
 * so a convention that used to be enforced by hand (and drifted twice when
 * parallel agents created issues without a milestone or priority) is a gate.
 *
 * Rules (from docs/agents/triage-labels.md):
 * - Every open issue carries exactly ONE triage role:
 *   needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix
 * - At most ONE priority label (P0..P3).
 * - Every open issue carries a milestone (AGENTS.md: new issues must be assigned one).
 * - An issue whose role is ready-for-agent / ready-for-human must also carry a
 *   priority — "ready" means fully specified, so it must be prioritised. A
 *   needs-triage / needs-info issue may legitimately have no priority yet.
 *
 * What it does NOT judge (green != full proof):
 * - Whether the chosen role or priority is CORRECT — only that it is present
 *   and unambiguous. A mis-prioritised issue still passes.
 * - Label vocabulary drift: if the role/priority label strings change in the
 *   tracker, CANONICAL_ROLES and the P regex below must be updated to match.
 * - Closed issues, and pull requests (the /issues endpoint returns both; PRs
 *   are filtered out).
 *
 * Requires `gh` with a token able to read the repository's issues. On a GitHub
 * runner that is the workflow's GITHUB_TOKEN; locally it is your `gh auth`.
 */

import { execFileSync } from 'node:child_process';

export const CANONICAL_ROLES = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];

const PRIORITY_RE = /^P[0-3]$/;
const READY_ROLES = new Set(['ready-for-agent', 'ready-for-human']);

/** @typedef {{name: string}} GitHubIssueLabel */
/** @typedef {{number: number, title: string, pull_request?: unknown, milestone?: unknown, labels?: readonly GitHubIssueLabel[] | null}} GitHubIssue */
/** @typedef {{number: number, title: string, reasons: string[]}} IssueViolation */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is GitHubIssueLabel} */
function isIssueLabel(value) {
  return isRecord(value) && typeof value.name === 'string';
}

/** @param {unknown} value @returns {value is GitHubIssue} */
function isGitHubIssue(value) {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    typeof value.title !== 'string'
  ) {
    return false;
  }
  const labels = value.labels;
  if (labels === undefined || labels === null) return true;
  if (!Array.isArray(labels)) return false;
  return /** @type {unknown[]} */ (labels).every(isIssueLabel);
}

/** @param {string} raw @returns {GitHubIssue[]} */
export function parseOpenIssues(raw) {
  const parsed = /** @type {unknown} */ (JSON.parse(raw));
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub issue response must be an array');
  }
  const issues = /** @type {unknown[]} */ (parsed);
  if (!issues.every(isGitHubIssue)) {
    throw new Error('GitHub issue response contains an invalid issue');
  }
  return issues;
}

/**
 * Pure: given open issues (GitHub /issues shape), return one entry per issue
 * that violates the metadata rules. No I/O, so it is unit-testable offline.
 * @param {readonly GitHubIssue[]} issues
 * @returns {IssueViolation[]}
 */
export function findViolations(issues) {
  const violations = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = (issue.labels ?? []).map((label) => label.name);
    const roles = labels.filter((name) => CANONICAL_ROLES.includes(name));
    const priorities = labels.filter((name) => PRIORITY_RE.test(name));
    const reasons = [];
    if (roles.length === 0) reasons.push('no triage role');
    if (roles.length > 1)
      reasons.push(`multiple triage roles: ${roles.join(', ')}`);
    if (priorities.length > 1)
      reasons.push(`multiple priority labels: ${priorities.join(', ')}`);
    if (!issue.milestone) reasons.push('no milestone');
    if (roles.some((role) => READY_ROLES.has(role)) && priorities.length === 0)
      reasons.push('ready-for-* without a priority');
    if (reasons.length > 0)
      violations.push({ number: issue.number, title: issue.title, reasons });
  }
  return violations;
}

/** @returns {string} */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    {
      encoding: 'utf8',
    },
  ).trim();
}

/** @param {string} repo @returns {GitHubIssue[]} */
function openIssues(repo) {
  const raw = execFileSync(
    'gh',
    ['api', `repos/${repo}/issues?state=open&per_page=100`, '--paginate'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseOpenIssues(raw);
}

async function main() {
  const repo = repository();
  const issues = openIssues(repo);
  const violations = findViolations(issues);
  if (violations.length === 0) {
    const count = issues.filter((i) => !i.pull_request).length;
    console.log(
      `issue-triage: OK — ${count} open issues each have a milestone, one triage role, and a priority where ready.`,
    );
    return;
  }
  for (const v of violations) {
    console.error(`#${v.number}  ${v.reasons.join('; ')}  —  ${v.title}`);
  }
  console.error(
    `\nissue-triage: ${violations.length} open issue(s) missing required metadata.`,
  );
  process.exitCode = 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-issue-triage.mjs')
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
