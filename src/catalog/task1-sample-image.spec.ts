import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { TASK1_SAMPLE_IMAGE_URL } from './operation-catalog';

const REPO_ROOT = join(__dirname, '../..');

// Issue #190. The sample chart is one asset with one URL, so the literal must
// live in exactly one place. Postman and the integration guide derive from the
// constant; the contract document and the captured grading fixture are static
// files that cannot import anything, and the committed collection is
// generated. Those four are checked to still name the same asset, and any
// other file naming it is drift.
const ALLOWED_FILES = [
  'src/catalog/operation-catalog.ts', // the definition
  'docs/integration-guide.md', // quotes it for a reader
  'docs/aihub_deliverable_1_api_contract_schema.md', // static deliverable
  'test/fixtures/ai-writing/grade-task1.request.json', // captured request
  'aihub.postman_collection.json', // generated
  'docs/adr/0060-writing-task1-sample-image-is-published-not-signed.md', // records it
];

const OBJECT_PATH = 'ielts-task1/';
const SELF = 'src/catalog/task1-sample-image.spec.ts';
const SKIP_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

function filesMentioningTheObject(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|json|md|cts|mts)$/.test(entry.name)) {
        continue;
      }
      const relativePath = relative(REPO_ROOT, full).replace(/\\/g, '/');
      if (relativePath === SELF) {
        continue;
      }
      if (readFileSync(full, 'utf8').includes(OBJECT_PATH)) {
        found.push(relativePath);
      }
    }
  };

  walk(REPO_ROOT);
  return found.sort();
}

describe('Task 1 sample image URL', () => {
  it('is named by no file beyond the allowed ones', () => {
    // Exact equality, not arrayContaining: the point of this test is that a
    // file nobody listed is a failure, which a containment check cannot see.
    expect(filesMentioningTheObject()).toEqual([...ALLOWED_FILES].sort());
  });

  it('is named by every allowed file, so the list cannot rot', () => {
    const naming = filesMentioningTheObject();

    for (const allowed of ALLOWED_FILES) {
      expect(naming).toContain(allowed);
    }
  });

  it('has the same URL in every file that names it', () => {
    for (const relativePath of ALLOWED_FILES) {
      const contents = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      if (!contents.includes(OBJECT_PATH)) {
        continue;
      }
      expect(contents).toContain(TASK1_SAMPLE_IMAGE_URL);
    }
  });
});
