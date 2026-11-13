#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANUAL_NO_STORE_HEADER =
  /(?:\b(?:reply|response)\.header|@Header)\(\s*(['"])Cache-Control\1\s*,\s*(['"])no-store\2\s*\)/giu;

/** @param {string} markdown @returns {number[]} */
export function ownerIssueNumbers(markdown) {
  /** @type {Set<number>} */
  const numbers = new Set();
  for (const line of markdown.split(/\r?\n/u)) {
    const rowId = /^\|\s*([A-Z]\d+)\s*\|/iu.exec(line)?.[1];
    if (!rowId) continue;

    const lastSeparator = line.lastIndexOf('|');
    const statusSeparator = line.lastIndexOf('|', lastSeparator - 1);
    const status = line.slice(statusSeparator + 1, lastSeparator).trim();
    if (/^(?:closed|resolved|solved)\b/iu.test(status)) continue;

    for (const match of status.matchAll(/\bowner:?\s*#([1-9]\d*)\b/giu)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

/**
 * @param {string} markdown
 * @param {ReadonlyMap<number, string>} issueStates
 * @returns {number[]}
 */
export function findClosedOwnerIssueNumbers(markdown, issueStates) {
  return ownerIssueNumbers(markdown).filter(
    (number) => issueStates.get(number) !== 'OPEN',
  );
}

/** @param {readonly {path: string, content: string}[]} files @returns {string[]} */
export function findManualNoStoreHeaders(files) {
  /** @type {string[]} */
  const violations = [];
  for (const file of files) {
    for (const match of file.content.matchAll(MANUAL_NO_STORE_HEADER)) {
      const line = file.content.slice(0, match.index).split('\n').length;
      violations.push(`${file.path}:${line}`);
    }
  }
  return violations;
}

/** @param {string} directory @param {string[]} files */
function routeSourceFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      routeSourceFiles(path, files);
    } else if (
      entry.isFile() &&
      /\.(?:controller|guard)\.ts$/u.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

/** @param {readonly number[]} numbers @returns {Map<number, string>} */
function ownerIssueStates(numbers) {
  if (numbers.length === 0) return new Map();

  const [owner, name] = (
    process.env.GITHUB_REPOSITORY ?? 'AiHub-Ecosystem/aihub-be'
  ).split('/');
  const issueFields = numbers
    .map((number) => `issue${number}:issue(number:${number}){number state}`)
    .join(' ');
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${issueFields}}}`;
  const raw = execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-f',
      `query=${query}`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  const response =
    /** @type {{data?: {repository?: Record<string, {number?: number, state?: string} | null>}, errors?: unknown[]}} */ (
      JSON.parse(raw)
    );
  const issues = response.data?.repository;
  if (!issues || response.errors?.length) {
    throw new Error('GitHub returned an invalid issue-state response');
  }

  return new Map(
    numbers.map((number) => [
      number,
      issues[`issue${number}`]?.state ?? 'MISSING',
    ]),
  );
}

function main() {
  const registerPath = join(ROOT, 'docs/agents/duplication-register.md');
  const register = readFileSync(registerPath, 'utf8');
  const ownerIssues = ownerIssueNumbers(register);
  const closedIssues = findClosedOwnerIssueNumbers(
    register,
    ownerIssueStates(ownerIssues),
  );
  const routeFiles = routeSourceFiles(join(ROOT, 'src/modules')).map(
    (path) => ({
      path: relative(ROOT, path).replaceAll('\\', '/'),
      content: readFileSync(path, 'utf8'),
    }),
  );
  const manualHeaders = findManualNoStoreHeaders(routeFiles);
  const violations = [
    ...closedIssues.map(
      (number) => `owner issue #${number} is closed or missing from GitHub`,
    ),
    ...manualHeaders.map(
      (path) =>
        `${path} sets Cache-Control: no-store outside the route catalog`,
    ),
  ];

  if (violations.length > 0) {
    console.error('Duplication register check failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Duplication register check passed (${ownerIssues.length} active issue owners, ${routeFiles.length} route files).`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch {
    console.error(
      'Duplication register check failed: could not read owner issue state from GitHub; check gh authentication and network access.',
    );
    process.exitCode = 1;
  }
}
