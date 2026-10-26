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

/** @param {string} command */
export function touchesIssue(command) {
  return /\bgh\s+issue\s+(create|edit)\b/.test(command);
}

/** @param {unknown} input @returns {string} */
export function commandFromInput(input) {
  if (typeof input !== 'object' || input === null) return '';
  const toolInput = /** @type {unknown} */ (Reflect.get(input, 'tool_input'));
  if (typeof toolInput !== 'object' || toolInput === null) return '';
  const command = /** @type {unknown} */ (Reflect.get(toolInput, 'command'));
  return typeof command === 'string' ? command : '';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const parsed = /** @type {unknown} */ (JSON.parse(input || '{}'));
  const command = commandFromInput(parsed);
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
