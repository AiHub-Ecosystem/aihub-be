import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const TEST_FILE_PATTERN = /\.(?:spec|test)\.tsx?$/;
const MARKDOWN_PATH_PATTERN = /['"`]((?:docs|ops)\/[^'"`\r\n]*\.md)['"`]/g;

function testReadMarkdownPaths(): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => TEST_FILE_PATTERN.test(file));
  const paths = new Set<string>();

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(MARKDOWN_PATH_PATTERN)) {
      if (match[1] !== undefined) paths.add(match[1]);
    }
  }

  return [...paths].sort();
}

function pushPathPatterns(): string[] {
  const lines = readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
  const pushIndex = lines.findIndex((line) => line === '  push:');
  const pathsIndex = lines.findIndex(
    (line, index) => index > pushIndex && line === '    paths:',
  );
  if (pushIndex < 0 || pathsIndex < 0) {
    throw new Error('CI push path filter is missing');
  }

  const patterns: string[] = [];
  for (const line of lines.slice(pathsIndex + 1)) {
    const match = /^      - "([^"]+)"$/.exec(line);
    if (match?.[1] === undefined) break;
    patterns.push(match[1]);
  }
  return patterns;
}

function patternMatches(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  if (pattern === '*.md') return !path.includes('/') && path.endsWith('.md');
  if (pattern === '**/*.md') return path.endsWith('.md');
  if (pattern === '.claude/**') return path.startsWith('.claude/');
  return pattern === path;
}

function matchesPushFilter(path: string, patterns: string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith('!');
    if (patternMatches(excluded ? pattern.slice(1) : pattern, path)) {
      included = !excluded;
    }
  }
  return included;
}

function pushRunsCi(changedFiles: string[]): boolean {
  const patterns = pushPathPatterns();
  return changedFiles.some((file) => matchesPushFilter(file, patterns));
}

describe('CI push path filter', () => {
  const markdownInputs = testReadMarkdownPaths();

  it('keeps every Markdown file read by a test in the workflow allowlist', () => {
    const configured = pushPathPatterns().filter(
      (pattern) => !pattern.startsWith('!') && pattern.endsWith('.md'),
    );
    expect(configured.sort()).toEqual(markdownInputs);
  });

  it('skips a docs-only push that tests do not read', () => {
    const docsOnlyFile = ['docs/agents/triage-labels', '.md'].join('');
    expect(pushRunsCi([docsOnlyFile])).toBe(false);
  });

  it('runs CI when a docs-only push changes a Markdown input read by a test', () => {
    const markdownInput = markdownInputs[0];
    if (!markdownInput)
      throw new Error('expected at least one test-read Markdown input');
    expect(pushRunsCi([markdownInput])).toBe(true);
  });

  it('still runs CI for source changes', () => {
    expect(pushRunsCi(['src/main.ts'])).toBe(true);
  });
});
