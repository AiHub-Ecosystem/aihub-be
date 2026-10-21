#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook (.claude/settings.json). After a shell call that
 * files or edits a GitHub issue, run the issue-triage audit so a missing
 * milestone, triage role or priority surfaces in the same turn instead of in
 * the next daily audit run. Any other command exits silently.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function touchesIssue(command) {
  return /\bgh\s+issue\s+(create|edit)\b/.test(command);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const command = JSON.parse(input || '{}').tool_input?.command ?? '';
  if (!touchesIssue(command)) return;

  const audit = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'check-issue-triage.mjs')],
    { encoding: 'utf8' },
  );
  if (audit.status === 0) return;

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: [
        'The issue-triage audit failed after a `gh issue create`/`edit`:',
        `${audit.stdout}${audit.stderr}`.trim(),
        'Every open issue needs a milestone, one triage role and a priority (docs/agents/issue-tracker.md). Pass `--milestone` to `gh issue create`, or fix the issue now.',
      ].join('\n'),
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
