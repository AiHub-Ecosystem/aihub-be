import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  pushPathPatterns as sharedPushPathPatterns,
  pushRunsCi as sharedPushRunsCi,
} from './ci-push-filter.cjs';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const TEST_FILE_PATTERN = /\.(?:spec|test)\.tsx?$/;
/** Markdown the Public API release gate reads on every push (#1398). */
const RELEASE_GATE_MARKDOWN = ['CHANGELOG.md'];
const MARKDOWN_PATH_PATTERN = /['"`]((?:docs|ops)\/[^'"`\r\n]*\.md)['"`]/g;

function testReadMarkdownPaths(): string[] {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => TEST_FILE_PATTERN.test(file) && existsSync(file));
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
  return sharedPushPathPatterns(readFileSync(WORKFLOW_PATH, 'utf8'));
}

function pushRunsCi(changedFiles: string[]): boolean {
  return sharedPushRunsCi(changedFiles, pushPathPatterns());
}

describe('CI push path filter', () => {
  const markdownInputs = testReadMarkdownPaths();

  it('keeps every Markdown file read by a test in the workflow allowlist', () => {
    const configured = pushPathPatterns().filter(
      (pattern) => !pattern.startsWith('!') && pattern.endsWith('.md'),
    );
    expect(configured.sort()).toEqual(
      [...markdownInputs, ...RELEASE_GATE_MARKDOWN].sort(),
    );
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

  it('runs CI when a push changes only the changelog the release gate reads', () => {
    expect(pushRunsCi(RELEASE_GATE_MARKDOWN)).toBe(true);
  });

  it('still runs CI for source changes', () => {
    expect(pushRunsCi(['src/main.ts'])).toBe(true);
  });
});
