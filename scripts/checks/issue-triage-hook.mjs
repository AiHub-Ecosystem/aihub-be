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

/** @param {unknown} input @returns {number | undefined} */
export function targetFromInput(input) {
  const record =
    typeof input === 'object' && input !== null
      ? /** @type {Record<string, unknown>} */ (input)
      : {};
  const toolInput = record.tool_input;
  const command =
    typeof toolInput === 'object' &&
    toolInput !== null &&
    typeof Reflect.get(toolInput, 'command') === 'string'
      ? /** @type {string} */ (Reflect.get(toolInput, 'command'))
      : '';
  const response = record.tool_response;
  const stdout =
    typeof response === 'object' &&
    response !== null &&
    typeof Reflect.get(response, 'stdout') === 'string'
      ? /** @type {string} */ (Reflect.get(response, 'stdout'))
      : '';
  const edit =
    /\bgh\s+issue\s+edit\s+(?:[^\s]*\/)?(?:issues\/)?(?:#?)([1-9]\d*)/.exec(
      command,
    );
  const created =
    /\bgh\s+issue\s+create\b/.test(command) &&
    /(?:github\.com\/[^\s]+\/issues\/|\bissues\/|#)([1-9]\d*)/.exec(stdout);
  const match = edit ?? created;
  return match ? Number(match[1]) : undefined;
}

/** @param {number | undefined} target @returns {string[]} */
export function auditArgs(target) {
  return target ? ['--target', String(target)] : [];
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const parsed = /** @type {unknown} */ (JSON.parse(input || '{}'));
  const command = commandFromInput(parsed);
  if (!touchesIssue(command)) return;
  const target = targetFromInput(parsed);

  const audit = spawnSync(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), 'check-issue-triage.mjs'),
      ...auditArgs(target),
    ],
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
