import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  basename,
  dirname,
  join,
  matchesGlob,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  codeRabbitConfigDrift,
  pathsFromRole,
} from '../../generate/coderabbit-config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** @typedef {{relation: string, id: string}} AdrTarget */

/** @param {string} directory @returns {string[]} */
function markdownFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

/** @param {string} path @returns {string | undefined} */
function adrIdOf(path) {
  return /^(\d{4})-.+\.md$/iu.exec(basename(path))?.[1];
}

/** @param {string} content @returns {string | undefined} */
function statusLine(content) {
  return content
    .split(/\r?\n/u)
    .find((line) => /^\s*-?\s*Status\s*:/iu.test(line));
}

/** @param {string} content @returns {string} */
function statusAndRelationLines(content) {
  return content
    .split(/\r?\n/u)
    .filter((line) =>
      /^\s*-?\s*(?:Status|Supersedes?|Amends?|Amended\s+by|Superseded\s+by)(?::|\s)/iu.test(
        line,
      ),
    )
    .join('\n');
}

/** @param {string} target @returns {string} */
function decodeMarkdownTarget(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** @param {string} content @returns {AdrTarget[]} */
function declaredAdrTargets(content) {
  /** @type {AdrTarget[]} */
  const targets = [];

  for (const line of content.split(/\r?\n/u)) {
    const declarations = [
      ...line.matchAll(
        /\b(?:(Amends|Supersedes)|(Amended|Superseded)\s+by)\s*(?::\s*|\s+(?=\[?ADR-\d{4}))/giu,
      ),
    ];

    declarations.forEach((declaration, index) => {
      const start = (declaration.index ?? 0) + declaration[0].length;
      const end = declarations[index + 1]?.index ?? line.length;
      const segment = line.slice(start, end).split(/\s+—\s+/u, 1)[0];
      for (const match of segment.matchAll(/\bADR-(\d{4})\b/giu)) {
        targets.push({
          relation: declaration[1] ?? declaration[2] ?? '',
          id: match[1] ?? '',
        });
      }
    });
  }

  return targets;
}

/** @param {string} path @param {string} content @returns {string[]} */
function missingAdrLinks(path, content) {
  /** @type {string[]} */
  const violations = [];

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = (match[1] ?? '')
      .trim()
      .replace(/^<|>$/gu, '')
      .split(/[?#]/u, 1)[0];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)) continue;

    const decodedTarget = decodeMarkdownTarget(target);

    const targetName = basename(decodedTarget.replaceAll('\\', '/'));
    if (!/^\d{4}-.+\.md$/iu.test(targetName)) continue;

    if (!existsSync(resolve(dirname(path), decodedTarget))) {
      violations.push(
        `${path}: ADR document link targets missing file ${target}`,
      );
    }
  }

  return violations;
}

/** @param {string} rootDir @returns {string[]} */
function missingOperationsPaths(rootDir) {
  /** @type {string[]} */
  const violations = [];
  const operationsDir = resolve(rootDir, 'docs/operations');
  const repoPathPattern =
    /(?<![\w./-])((?:\.\/)?(?:scripts|ops|src|test|docs)\/(?:[\w.*?<>-]+\/)*[\w.*?<>-]+)/gu;
  const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;

  for (const path of markdownFiles(operationsDir)) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      /** @type {Set<string>} */
      const repositoryPaths = new Set();
      for (const match of line.matchAll(repoPathPattern)) {
        const repositoryPath = match[1]
          .replace(/^\.\//u, '')
          .replace(/[.,;:]+$/u, '');
        if (/[*?<>]/u.test(repositoryPath)) continue;
        repositoryPaths.add(repositoryPath);
      }

      for (const match of line.matchAll(markdownLinkPattern)) {
        const target = (match[1] ?? '')
          .trim()
          .replace(/^<|>$/gu, '')
          .split(/[?#]/u, 1)[0];
        if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)) continue;

        const decodedTarget = decodeMarkdownTarget(target);

        const resolvedTarget = resolve(dirname(path), decodedTarget);
        const repositoryPath = relative(rootDir, resolvedTarget).replaceAll(
          '\\',
          '/',
        );
        if (
          /^(?:scripts|ops|src|test|docs)\//u.test(repositoryPath) &&
          !/[*?<>]/u.test(repositoryPath)
        ) {
          repositoryPaths.add(repositoryPath);
        }
      }

      for (const repositoryPath of repositoryPaths) {
        if (!existsSync(resolve(rootDir, repositoryPath))) {
          violations.push(
            `${path}:${index + 1}: missing repository path ${repositoryPath}`,
          );
        }
      }
    });
  }

  return violations;
}

/** @param {string} [rootDir] @returns {string[]} */
export function findDocDriftViolations(rootDir = REPO_ROOT) {
  const repositoryRoot = resolve(rootDir);
  const adrDir = resolve(repositoryRoot, 'docs/adr');
  const files = markdownFiles(adrDir);
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const path of files) {
    const id = adrIdOf(path);
    if (id !== undefined) {
      const list = byId.get(id);
      if (list) list.push(path);
      else byId.set(id, [path]);
    }
  }
  /** @type {string[]} */
  const violations = [];

  for (const [id, paths] of byId) {
    if (paths.length > 1) {
      const named = paths
        .map((path) => relative(repositoryRoot, path).replace(/\\/g, '/'))
        .sort();
      violations.push(`ADR-${id} has duplicate files: ${named.join(', ')}`);
    }
  }

  for (const path of files) {
    const id = adrIdOf(path);
    if (id === undefined) continue;

    const content = readFileSync(path, 'utf8');
    const status = statusLine(content);
    if (status === undefined) violations.push(`ADR-${id} has no Status line`);

    for (const relation of declaredAdrTargets(content)) {
      const targets = byId.get(relation.id);
      if (targets === undefined || targets.length === 0) {
        violations.push(
          `ADR-${id} declares ${relation.relation} ADR-${relation.id}, but that ADR file is missing`,
        );
        continue;
      }

      const re = new RegExp(String.raw`\bADR-${id}\b`, 'iu');
      const satisfied = targets.some((targetPath) => {
        const targetStatus = statusAndRelationLines(
          readFileSync(targetPath, 'utf8'),
        );
        return re.test(targetStatus);
      });
      if (!satisfied) {
        violations.push(
          `ADR-${relation.id} status does not name ADR-${id}, declared by ADR-${id}`,
        );
      }
    }

    violations.push(...missingAdrLinks(path, content));
  }

  violations.push(...missingOperationsPaths(repositoryRoot));
  return violations;
}

/** @param {string} pattern @returns {string[]} */
function expandBraceAlternatives(pattern) {
  const match = /\{([^}]+)\}/u.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return match[1]
    .split(',')
    .flatMap((alternative) =>
      expandBraceAlternatives(`${prefix}${alternative}${suffix}`),
    );
}

/**
 * Every directory under `src/modules` must be reachable by a role's file
 * ownership glob. The narrower-claim rule in AGENTS.md resolves overlaps.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function unclaimedModuleDirectories(rootDir = REPO_ROOT) {
  const root = resolve(rootDir);
  const agentsDir = join(root, '.claude/agents');
  const modulesDir = join(root, 'src/modules');
  if (!existsSync(agentsDir) || !existsSync(modulesDir)) return [];

  /** @type {string[]} */
  const patterns = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(join(agentsDir, file), 'utf8');
    for (const path of pathsFromRole(content, `.claude/agents/${file}`)) {
      patterns.push(...expandBraceAlternatives(path));
    }
  }

  /** @type {string[]} */
  const directories = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = join(directory, entry.name);
      directories.push(relative(root, absolute).replaceAll('\\', '/'));
      walk(absolute);
    }
  };
  walk(modulesDir);
  directories.sort();

  return directories.flatMap((directory) => {
    const probe = `${directory}/__role_ownership_probe__.ts`;
    return patterns.some((pattern) => matchesGlob(probe, pattern))
      ? []
      : [`${directory}: no role claim in .claude/agents/`];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const violations = [
    ...findDocDriftViolations(),
    ...codeRabbitConfigDrift(REPO_ROOT),
    ...unclaimedModuleDirectories(REPO_ROOT),
  ];
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('doc-drift: OK');
  }
}
