#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const COMMIT_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];

const MAX_HEADER_LENGTH = 100;

// The header shape Conventional Commits defines: a known type, an optional
// lowercase scope, an optional breaking-change marker, then the subject.
const HEADER_PATTERN = new RegExp(
  `^(${COMMIT_TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`,
);

// Git writes these itself, or a rebase produces them. They carry no author
// intent for this check to judge, so they pass untouched.
const EXEMPT_PATTERNS = [/^Merge /, /^Revert "/, /^fixup! /, /^squash! /];

function headerOf(message) {
  return message
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .find((line) => line.length > 0 && !line.startsWith('#'));
}

function problemsIn(message) {
  const header = headerOf(message);
  if (header === undefined) return ['the commit message is empty'];
  if (EXEMPT_PATTERNS.some((pattern) => pattern.test(header))) return [];

  const problems = [];
  if (header.length > MAX_HEADER_LENGTH) {
    problems.push(
      `the header is ${header.length} characters; the maximum is ${MAX_HEADER_LENGTH}`,
    );
  }
  if (!HEADER_PATTERN.test(header)) {
    problems.push(
      `the header must be "type(scope): subject", with type one of ${COMMIT_TYPES.join(', ')}`,
    );
  }
  return problems;
}

const file = process.argv[2];
if (file === undefined) {
  console.error(
    'usage: node scripts/checks/commit-message.mjs <commit-message-file>',
  );
  process.exit(2);
}

let message;
try {
  message = readFileSync(file, 'utf8');
} catch {
  console.error(`cannot read the commit message file: ${file}`);
  process.exit(2);
}

const problems = problemsIn(message);
if (problems.length > 0) {
  console.error('Commit message rejected:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('');
  console.error('Example: fix(gateway): bound the retry budget ledger');
  process.exit(1);
}
