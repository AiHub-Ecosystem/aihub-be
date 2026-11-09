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
 * - Closed issues, and pull requests (the full audit reads only open issues;
 *   the targeted audit skips a closed issue).
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
const TARGET_RE = /(?:^|\s)--target\s+([1-9]\d*)(?:\s|$)/;

export const trackerQuery =
  'query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(states:OPEN,first:100,after:$endCursor){nodes{number title labels(first:100){nodes{name}} milestone{number}} pageInfo{hasNextPage endCursor}}}}';

/** @typedef {{name: string}} GitHubIssueLabel */
/** @typedef {{number: number, title: string, pull_request?: unknown, milestone?: unknown, labels?: readonly GitHubIssueLabel[] | null}} GitHubIssue */
/** @typedef {{number: number, title: string, reasons: string[]}} IssueViolation */
/** @typedef {{data?: {repository?: {issues?: {nodes?: readonly Record<string, unknown>[]}}}}} GraphQLPage */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is GitHubIssueLabel} */
function isIssueLabel(value) {
  return isRecord(value) && typeof value.name === 'string';
}

/** @param {readonly string[]} args @returns {number | undefined} */
export function parseTarget(args) {
  const match = TARGET_RE.exec(args.join(' '));
  if (!match) {
    if (args.includes('--target')) {
      throw new Error('--target needs a positive issue number');
    }
    return undefined;
  }
  return Number(match[1]);
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
 * `--paginate --slurp` returns one GraphQL response per page; concatenate
 * their narrow issue nodes before the existing validation runs.
 * @param {string} raw
 * @returns {GitHubIssue[]}
 */
export function parseTrackerPages(raw) {
  const pages = /** @type {unknown} */ (JSON.parse(raw));
  if (
    !Array.isArray(pages) ||
    !pages.every((page) => isRecord(page) && isRecord(page.data))
  ) {
    throw new Error('GitHub tracker response must contain issue pages');
  }
  const typedPages = /** @type {GraphQLPage[]} */ (pages);
  /** @type {unknown[]} */
  const nodes = [];
  for (const page of typedPages) {
    const issues = page.data?.repository?.issues;
    if (!issues || !Array.isArray(issues.nodes)) {
      throw new Error('GitHub tracker response contains an invalid page');
    }
    for (const node of issues.nodes ?? []) nodes.push(node);
  }
  return parseOpenIssues(JSON.stringify(normalizeNodes(nodes)));
}

/** @param {readonly unknown[]} nodes @returns {unknown[]} */
function normalizeNodes(nodes) {
  return nodes.map((node) => {
    const record = isRecord(node) ? node : {};
    const labels = isRecord(record.labels) ? record.labels : undefined;
    return {
      ...record,
      labels: labels?.nodes,
    };
  });
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
function fullIssues(repo) {
  const raw = execFileSync(
    'gh',
    [
      'api',
      'graphql',
      ...repoVariables(repo),
      '-F',
      `query=${trackerQuery}`,
      '--paginate',
      '--slurp',
      '--cache',
      '1h',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseTrackerPages(raw);
}

/** @param {number} number @returns {GitHubIssue[]} */
function targetIssue(number) {
  const raw = execFileSync(
    'gh',
    [
      'api',
      `repos/:owner/:repo/issues/${number}`,
      '--jq',
      '{number,title,labels,milestone,state}',
      // shortcut: a 5s cache may reuse metadata after back-to-back edits; remove it when gh startup drops below 1s.
      '--cache',
      '5s',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  const issue = /** @type {{state?: string}} */ (JSON.parse(raw));
  return issue.state === 'open' ? parseOpenIssues(`[${raw.trim()}]`) : [];
}

/** @param {string} repo @returns {string[]} */
function repoVariables(repo) {
  const [owner, name] = repo.split('/');
  return ['-F', `owner=${owner}`, '-F', `name=${name}`];
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  const issues = target ? targetIssue(target) : fullIssues(repository());
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
