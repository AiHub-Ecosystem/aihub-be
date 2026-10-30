// The Integration Guide promises that every new public error code and every
// new value of an open response enum is named under `Added` in the changelog
// entry of the contract version that introduced it (#1419). Adding such a
// value is compatible, so the breaking-change check passes it; this check makes
// sure the release still tells integrators about it.

// Keywords whose schemas describe the same value, so they keep its path.
const SAME_VALUE_KEYWORDS = [
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
];

/** @typedef {{info: Record<string, unknown>, paths: Record<string, unknown>, components?: Record<string, unknown>}} OpenApiDocument */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {string} changelog @param {string} version */
export function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

/** Every `### Added` block of an entry, joined. @param {string} section @returns {string} */
function addedText(section) {
  /** @type {string[]} */
  const lines = [];
  let inAdded = false;
  for (const line of section.split(/\r?\n/)) {
    if (line.startsWith('### ')) inAdded = /^### Added\b/.test(line);
    else if (inAdded) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * A value is named as a code span, so a word in prose never stands in for it.
 * @param {string} text @param {string} value
 */
function names(text, value) {
  return text.includes(`\`${value}\``);
}

/**
 * Every value of each response enum marked `x-extensible-enum`, keyed by the
 * enum's property path from the response body (`error.code`,
 * `data.events[].action`). One path is one enum across all routes and
 * statuses, so a code that moves to another response is not new.
 * @param {OpenApiDocument} document
 * @returns {Map<string, Set<string>>}
 */
export function extensibleResponseEnums(document) {
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  const responses = isRecord(components.responses) ? components.responses : {};
  /** @type {Map<string, Set<string>>} */
  const enums = new Map();

  /** @param {unknown} node @param {string} path @param {Set<string>} seen */
  function visitSchema(node, path, seen) {
    if (Array.isArray(node)) {
      for (const item of node) visitSchema(item, path, seen);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.$ref === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
      if (match && !seen.has(match[1])) {
        visitSchema(schemas[match[1]], path, new Set([...seen, match[1]]));
      }
    }
    const values = node['x-extensible-enum'];
    if (Array.isArray(values)) {
      const known = enums.get(path) ?? new Set();
      for (const value of values) known.add(String(value));
      enums.set(path, known);
    }
    if (isRecord(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        visitSchema(child, path === '' ? name : `${path}.${name}`, seen);
      }
    }
    visitSchema(node.items, `${path}[]`, seen);
    visitSchema(node.prefixItems, `${path}[]`, seen);
    visitSchema(node.additionalProperties, `${path}{}`, seen);
    for (const key of SAME_VALUE_KEYWORDS) visitSchema(node[key], path, seen);
  }

  /** @param {unknown} response @param {Set<string>} seen */
  function visitResponse(response, seen) {
    if (!isRecord(response)) return;
    if (typeof response.$ref === 'string') {
      const match = /^#\/components\/responses\/(.+)$/.exec(response.$ref);
      if (match && !seen.has(match[1])) {
        visitResponse(responses[match[1]], new Set([...seen, match[1]]));
      }
      return;
    }
    if (!isRecord(response.content)) return;
    for (const media of Object.values(response.content)) {
      if (isRecord(media)) visitSchema(media.schema, '', new Set());
    }
  }

  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isRecord(operation) || !isRecord(operation.responses)) continue;
      for (const response of Object.values(operation.responses)) {
        visitResponse(response, new Set());
      }
    }
  }
  return enums;
}

/**
 * Throws unless each value the candidate adds to an extensible response enum
 * is named under `### Added` in the changelog entry for the candidate's
 * contract version.
 * @param {OpenApiDocument} baseDocument
 * @param {OpenApiDocument} candidateDocument
 * @param {string} changelog
 * @param {number} major
 * @param {string} version
 */
export function requireAddedEnumValues(
  baseDocument,
  candidateDocument,
  changelog,
  major,
  version,
) {
  const before = extensibleResponseEnums(baseDocument);
  /** @type {Array<[string, string]>} */
  const added = [];
  for (const [path, values] of extensibleResponseEnums(candidateDocument)) {
    const known = before.get(path) ?? new Set();
    for (const value of values) {
      if (!known.has(value)) added.push([path, value]);
    }
  }
  if (added.length === 0) return;

  const listed = addedText(sectionFor(changelog, version));
  const entries = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)]
    .map((match) => match[1])
    .filter((entry) => entry !== undefined && entry !== version);
  const missing = added
    .filter(([, value]) => !names(listed, value))
    .map(([path, value]) => {
      const elsewhere = entries.find((entry) =>
        names(addedText(sectionFor(changelog, entry)), value),
      );
      const hint =
        elsewhere === undefined ? '' : ` (listed under ${elsewhere} instead)`;
      return `- /v${major} contract ${version}: ${path} value ${value} is missing${hint}`;
    });
  if (missing.length > 0) {
    throw new Error(
      `CHANGELOG.md ${version} entry must name each new value of an extensible response enum under ### Added:\n${missing.join('\n')}`,
    );
  }
}
