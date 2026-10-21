import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { touchesIssue } from './issue-triage-hook.mjs';

await test('fires on commands that file or edit an issue', () => {
  assert.equal(
    touchesIssue('gh issue create --title x --body-file b.md'),
    true,
  );
  assert.equal(
    touchesIssue('foreach ($n in 1..2) { gh issue edit $n --add-label P3 }'),
    true,
  );
  assert.equal(touchesIssue('gh issue view 1'), false);
  assert.equal(touchesIssue('gh issue comment 1 --body-file b.md'), false);
});

await test('exits silently for any other command without calling GitHub', () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'issue-triage-hook.mjs')],
    {
      input: JSON.stringify({ tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
