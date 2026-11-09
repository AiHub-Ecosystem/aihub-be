import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const CODE_RABBIT_PATH = '.coderabbit.yaml';
const API_SCOPES = ['src/**/*.controller.ts', 'src/**/presentation/**'];
const IDENTITY_SCOPE =
  '{src/modules/identity/*/application/**,src/modules/identity/*/domain/**,src/modules/identity/*/infrastructure/**,src/modules/identity/*/public/**,src/modules/identity/shared/application/**,src/modules/identity/shared/domain/**,src/modules/identity/shared/infrastructure/**,src/modules/identity/domain/**,src/modules/identity/public/**,src/modules/identity/identity.module.ts,src/common/request-context/**,src/common/security/**}';
const CHECKS_SCOPE = 'scripts/checks/**';
const MAX_PATH_INSTRUCTIONS_LENGTH = 20_000;

/** @param {string} rootDir @param {string} directory @returns {string[]} */
function markdownFiles(rootDir, directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      relative(rootDir, join(directory, entry.name)).replaceAll('\\', '/'),
    )
    .sort();
}

/** @param {string} rootDir @param {string} path @returns {string} */
function readSource(rootDir, path) {
  return readFileSync(join(rootDir, path), 'utf8');
}

/** @param {string} content @param {string} path @returns {string[]} */
function pathsFromRule(content, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
  const pathList = /^paths:\r?\n((?:\s+- "[^"\r\n]+"\r?\n?)+)/mu.exec(
    frontmatter ?? '',
  )?.[1];
  if (!pathList) throw new Error(`${path} has no paths frontmatter`);
  return [...pathList.matchAll(/^\s+- "([^"]+)"/gmu)].map((match) => match[1]);
}

/** @param {string} content @param {string} path @returns {string[]} */
function pathsFromRole(content, path) {
  const ownership =
    /\*\*File ownership:\*\*\s*\r?\n([\s\S]*?)(?=\r?\n\*\*|$)/u.exec(
      content,
    )?.[1];
  const paths = [...(ownership ?? '').matchAll(/^\s*-\s+`([^`]+)`/gmu)].map(
    (match) => match[1].replaceAll('<feature>', '*'),
  );
  if (paths.length === 0)
    throw new Error(`${path} has no file ownership paths`);
  return paths;
}

/** @param {readonly string[]} paths @returns {string} */
function pathAlternatives(paths) {
  return `{${paths.join(',')}}`;
}

/** @param {string} value @returns {string} */
function yamlString(value) {
  return JSON.stringify(value);
}

/** @param {string} rootDir @returns {string} */
export function renderCodeRabbitConfig(rootDir) {
  const agentsDir = join(rootDir, '.claude/agents');
  const rulesDir = join(rootDir, '.claude/rules');
  const agentFiles = markdownFiles(rootDir, agentsDir);
  const ruleFiles = markdownFiles(rootDir, rulesDir);
  const agents = new Map(
    agentFiles.map((path) => [
      path,
      pathsFromRole(readSource(rootDir, path), path),
    ]),
  );
  const ruleScopes = ruleFiles.map((path) =>
    pathsFromRule(readSource(rootDir, path), path),
  );
  const identityText = readSource(rootDir, '.claude/agents/identity.md');
  const authText = readSource(rootDir, '.claude/agents/auth.md');
  const infrastructureText = readSource(
    rootDir,
    '.claude/agents/infrastructure.md',
  );
  const rootInstructions = readSource(rootDir, 'AGENTS.md');

  if (!rootInstructions.includes('narrower claim wins')) {
    throw new Error('AGENTS.md is missing the narrower role ownership rule');
  }
  if (!rootInstructions.includes('src/modules/identity/<feature>/<layer>/')) {
    throw new Error('AGENTS.md is missing the Identity feature-layer layout');
  }
  if (!identityText.includes('src/modules/identity/**')) {
    throw new Error('Identity role ownership no longer covers its module');
  }
  if (!infrastructureText.includes('scripts/**')) {
    throw new Error('Infrastructure role ownership no longer covers scripts');
  }
  if (ruleScopes.length === 0)
    throw new Error('No path-scoped rules were found');

  const apiPaths = (agents.get('.claude/agents/api.md') ?? []).filter(
    (path) =>
      path.endsWith('.controller.ts') || path.includes('/presentation/'),
  );
  const authPaths = agents.get('.claude/agents/auth.md') ?? [];
  if (apiPaths.length !== API_SCOPES.length) {
    throw new Error('API role must own controller and presentation paths');
  }
  if (!authText.includes('shared/')) {
    throw new Error('Auth role is missing its shared-layer ownership');
  }

  const pathInstructions = [
    {
      path: pathAlternatives(apiPaths),
      instructions:
        'Review under the api role in .claude/agents/api.md. Apply AGENTS.md and all matching .claude/rules/*.md. Keep controllers thin, validate request bodies with parseRequestBody, and prevent direct database, Redis, downstream calls, or secret and raw-body exposure.',
    },
    {
      path: IDENTITY_SCOPE,
      instructions:
        'Review under the identity role in .claude/agents/identity.md. Apply AGENTS.md and matching path-scoped rules. Keep organization identity explicit and preserve tenant isolation, credential handling, TTL and algorithm constraints, and secret redaction. API owns presentation paths and controllers; this scope excludes them.',
    },
    {
      path: pathAlternatives(authPaths),
      instructions:
        'Review under the auth role in .claude/agents/auth.md. Use another feature’s public facade or application port; keep shared implementations under shared/ and never import feature-private layers from shared/. Apply AGENTS.md and matching path-scoped rules.',
    },
    {
      path: CHECKS_SCOPE,
      instructions:
        'For scripts/checks, confirm each guarded rule has a behavior spec; confirm each checker is wired into check:changed and `bun run verify`; keep its measured folder under the direct-entry ceiling; add no grandfather allowlist.',
    },
  ];
  const instructionLength = pathInstructions.reduce(
    (total, entry) => total + entry.instructions.length,
    0,
  );
  if (instructionLength >= MAX_PATH_INSTRUCTIONS_LENGTH) {
    throw new Error(
      'CodeRabbit path instructions exceed the 20,000-character limit',
    );
  }

  const lines = [
    'version: 2',
    'reviews:',
    '  auto_review:',
    '    enabled: false',
    '    drafts: false',
    '    labels:',
    '      - "coderabbit-review"',
    '    ignore_usernames:',
    '      - "dependabot[bot]"',
    '      - "github-actions[bot]"',
    '  path_instructions:',
    ...pathInstructions.flatMap(({ path, instructions }) => [
      `    - path: ${yamlString(path)}`,
      `      instructions: ${yamlString(instructions)}`,
    ]),
    'knowledge_base:',
    '  code_guidelines:',
    '    filePatterns:',
    ...agentFiles.flatMap((path) => [
      `      - files: ${yamlString(path)}`,
      `        applyTo: ${yamlString((agents.get(path) ?? []).join(', '))}`,
    ]),
  ];

  return `${lines.join('\n')}\n`;
}

/** @param {string} rootDir @returns {string[]} */
export function codeRabbitConfigDrift(rootDir) {
  const expected = renderCodeRabbitConfig(rootDir);
  const actualPath = join(rootDir, CODE_RABBIT_PATH);
  if (existsSync(actualPath) && readFileSync(actualPath, 'utf8') === expected) {
    return [];
  }
  return [
    `${CODE_RABBIT_PATH} is stale; run bun run generate:coderabbit-config`,
  ];
}
