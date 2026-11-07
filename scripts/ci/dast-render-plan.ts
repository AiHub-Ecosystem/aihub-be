/**
 * Renders the ZAP Automation Framework plan for one DAST run (issue #319).
 *
 *   node --import tsx scripts/ci/dast-render-plan.ts --mode passive \
 *     --target http://dast.aihub.invalid:3000 \
 *     --api-key <seeded key> --bearer <access token> \
 *     --out temp/dast/zap-plan.yaml
 *
 * The version-controlled inputs are `ops/dast/zap-plan.template.yaml` and
 * `ops/dast/zap-rules.ts`. The renderer substitutes the target and the
 * credentials minted inside the CI job, injects the rules at the
 * `@dast-rules` markers, and, for the passive pull-request run, strips the
 * `@dast-only` blocks that belong to the scheduled active scan. It refuses to
 * write a plan that still carries a placeholder or a marker, so a template
 * edit that outgrows the renderer fails the job instead of scanning blind.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_RULES,
  type ActiveRule,
  PASSIVE_RULES,
  type PassiveRule,
} from '../../ops/dast/zap-rules';

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../ops/dast/zap-plan.template.yaml',
);

export interface RenderInput {
  readonly mode: 'passive' | 'active';
  readonly target: string;
  readonly apiKey: string;
  readonly bearer: string;
}

interface RenderOptions {
  readonly template?: string;
}

function renderRuleEntries(
  rules: readonly (PassiveRule | ActiveRule)[],
  indent: string,
): string {
  return rules
    .map((rule) => {
      const lines: string[] = [];
      if (rule.threshold === 'off') {
        lines.push(`${indent}# IGNORE: ${rule.reason}`);
      } else if ('reason' in rule && rule.reason !== undefined) {
        lines.push(`${indent}# ${rule.reason}`);
      }
      lines.push(`${indent}- id: ${rule.id}`);
      lines.push(`${indent}  name: ${rule.name}`);
      lines.push(`${indent}  threshold: ${rule.threshold}`);
      if ('strength' in rule && rule.strength !== undefined) {
        lines.push(`${indent}  strength: ${rule.strength}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

export function renderPlan(
  input: RenderInput,
  options: RenderOptions = {},
): string {
  const rawTemplate =
    options.template ??
    readFileSync(TEMPLATE_PATH, 'utf8').replaceAll('\r\n', '\n');
  // The rendered plan carries no authoring commentary: everything before the
  // top-level `env:` is this repository's explanation of the template, not
  // configuration ZAP needs.
  const envStart = rawTemplate.match(/^env:\s*$/m);
  if (envStart === null || envStart.index === undefined) {
    throw new Error('plan template has no top-level env: block');
  }
  const template = rawTemplate.slice(envStart.index);

  let plan = template;
  if (input.mode === 'passive') {
    plan = plan.replace(
      /^ *# @dast-only:start\n[\s\S]*?^ *# @dast-only:end\n\n?/m,
      '',
    );
  } else {
    plan = plan
      .replace(/^ *# @dast-only:start\n/m, '')
      .replace(/^ *# @dast-only:end\n/m, '');
  }
  if (plan.includes('@dast-only')) {
    throw new Error('rendered plan still carries a @dast-only block');
  }

  plan = plan.replace(
    /^(\s*)# @dast-rules:(passive|active)\s*$/gm,
    (_line, indent: string, section: string) => {
      const rules = section === 'passive' ? PASSIVE_RULES : ACTIVE_RULES;
      if (rules.length === 0) {
        throw new Error(`no ${section} rules are configured`);
      }
      return renderRuleEntries(rules, indent);
    },
  );
  if (plan.includes('@dast-rules:')) {
    throw new Error('rendered plan still carries a @dast-rules marker');
  }

  plan = plan
    .replaceAll('${AIHUB_TARGET}', input.target)
    .replaceAll('${AIHUB_API_KEY}', input.apiKey)
    .replaceAll('${AIHUB_BEARER}', input.bearer);

  const leftover = plan.match(/\$\{[^}]*\}/);
  if (leftover !== null) {
    throw new Error(
      `rendered plan still carries a placeholder: ${leftover[0]}`,
    );
  }
  return plan;
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required option --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (name === undefined || value === undefined) {
      throw new Error(`usage: --mode --target --api-key --bearer --out`);
    }
    values.set(name, value);
  }

  const mode = requireOption(values, 'mode');
  if (mode !== 'passive' && mode !== 'active') {
    throw new Error(`--mode must be passive or active, got ${mode}`);
  }
  const output = renderPlan({
    mode,
    target: requireOption(values, 'target'),
    apiKey: requireOption(values, 'api-key'),
    bearer: requireOption(values, 'bearer'),
  });

  const out = requireOption(values, 'out');
  writeFileSync(out, output);
  console.log(`dast-render-plan: wrote ${out}`);
}

// Runs only when invoked as a script, never when the spec imports renderPlan.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`dast-render-plan: ${(error as Error).message}`);
    process.exit(2);
  });
}
