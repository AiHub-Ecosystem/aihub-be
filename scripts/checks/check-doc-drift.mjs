import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
        /\b(Amends|Supersedes)\s*:\s*|\b(Amends|Supersedes)\s+(?=ADR-\d{4})/giu,
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
  // shortcut: check explicit root tokens and Markdown links; extend if runbooks adopt another path form.
  const repoPathPattern =
    /(?<![\w./-])((?:\.\/)?(?:scripts|ops|src)\/(?:[\w.*?<>-]+\/)*[\w.*?<>-]+)/gu;
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
          /^(?:scripts|ops|src)\//u.test(repositoryPath) &&
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
  /** @type {Map<string, string>} */
  const byId = new Map();
  for (const path of files) {
    const id = adrIdOf(path);
    if (id !== undefined) byId.set(id, path);
  }
  /** @type {string[]} */
  const violations = [];

  for (const path of files) {
    const id = adrIdOf(path);
    if (id === undefined) continue;

    const content = readFileSync(path, 'utf8');
    const status = statusLine(content);
    if (status === undefined) violations.push(`ADR-${id} has no Status line`);

    for (const relation of declaredAdrTargets(content)) {
      const target = byId.get(relation.id);
      if (target === undefined) {
        violations.push(
          `ADR-${id} declares ${relation.relation} ADR-${relation.id}, but that ADR file is missing`,
        );
        continue;
      }

      const targetStatus = statusLine(readFileSync(target, 'utf8'));
      if (
        targetStatus !== undefined &&
        !new RegExp(`\\bADR-${id}\\b`, 'iu').test(targetStatus)
      ) {
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const violations = findDocDriftViolations();
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('doc-drift: OK');
  }
}
