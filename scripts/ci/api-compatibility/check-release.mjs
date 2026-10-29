import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { checkMajorLifecycle } from './check-major-lifecycle.mjs';
import { findBreakingChanges } from './check.mjs';

const VERSIONED_SPEC = /^v([1-9]\d*)\.json$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SCHEMA_CHILDREN = [
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'additionalProperties',
  'prefixItems',
  'if',
  'then',
  'else',
];
const DOC_FIELDS = new Set([
  'description',
  'summary',
  'externalDocs',
  'example',
  'examples',
]);

/** @typedef {{info: Record<string, unknown>, paths: Record<string, unknown>, components?: Record<string, unknown>}} OpenApiDocument */
/** @typedef {{level: number, text: string}} ApiChange */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {string} value @returns {[number, number, number]} */
function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`Invalid public API SemVer: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {string} path @returns {OpenApiDocument} */
function readDocument(path) {
  const value = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.paths)) {
    throw new Error(`${path} is not an OpenAPI document`);
  }
  return /** @type {OpenApiDocument} */ (value);
}

/** @param {string} root @returns {Map<number, OpenApiDocument>} */
function listVersionedSpecs(root) {
  const directory = join(root, 'openapi');
  /** @type {Map<number, OpenApiDocument>} */
  const specs = new Map();
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return specs;
    }
    throw error;
  }

  for (const name of names) {
    const match = VERSIONED_SPEC.exec(name);
    if (match) specs.set(Number(match[1]), readDocument(join(directory, name)));
  }
  return specs;
}

/** @param {OpenApiDocument} document @param {string} label @returns {string} */
function validateVersionedDocument(document, label) {
  const version = document.info.version;
  if (typeof version !== 'string') {
    throw new Error(`${label} has no public API info.version`);
  }
  const [major] = parseVersion(version);
  const paths = Object.keys(document.paths);
  if (
    paths.length === 0 ||
    paths.some((path) => !path.startsWith(`/v${major}/`))
  ) {
    throw new Error(`${label} must document only /v${major} public routes`);
  }
  return version;
}

/** @param {unknown} value @param {(schema: Record<string, unknown>) => void} visit @param {Record<string, unknown>} componentSchemas @param {Set<string>} [seen] */
function walkSchema(value, visit, componentSchemas, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) walkSchema(item, visit, componentSchemas, seen);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.$ref === 'string') {
    const match = /^#\/components\/schemas\/(.+)$/.exec(value.$ref);
    if (match && !seen.has(match[1])) {
      const referenced = componentSchemas[match[1]];
      if (referenced !== undefined) {
        const nextSeen = new Set(seen);
        nextSeen.add(match[1]);
        walkSchema(referenced, visit, componentSchemas, nextSeen);
      }
    }
  }
  visit(value);
  if (isRecord(value.properties)) {
    for (const property of Object.values(value.properties)) {
      walkSchema(property, visit, componentSchemas, seen);
    }
  }
  for (const key of SCHEMA_CHILDREN) {
    walkSchema(value[key], visit, componentSchemas, seen);
  }
}

/** @param {OpenApiDocument} document @returns {unknown[]} */
function collectResponseSchemas(document) {
  const components = isRecord(document.components) ? document.components : {};
  const componentResponses = isRecord(components.responses)
    ? components.responses
    : {};
  /** @type {unknown[]} */
  const schemas = [];

  /** @param {unknown} response @param {Set<string>} [seen] */
  function visitResponse(response, seen = new Set()) {
    if (!isRecord(response)) return;
    if (typeof response.$ref === 'string') {
      const match = /^#\/components\/responses\/(.+)$/.exec(response.$ref);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);
      visitResponse(componentResponses[match[1]], seen);
      return;
    }
    if (!isRecord(response.content)) return;
    for (const media of Object.values(response.content)) {
      if (isRecord(media)) schemas.push(media.schema);
    }
  }

  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isRecord(operation) || !isRecord(operation.responses)) continue;
      for (const response of Object.values(operation.responses)) {
        visitResponse(response);
      }
    }
  }
  for (const response of Object.values(componentResponses)) {
    visitResponse(response);
  }
  return schemas;
}

/** @param {OpenApiDocument} document @param {string} label */
function validateSchemaPolicies(document, label) {
  const components = isRecord(document.components) ? document.components : {};
  const componentSchemas = isRecord(components.schemas)
    ? components.schemas
    : {};
  /** @type {Array<[string, unknown]>} */
  const requestSchemas = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isRecord(operation)) continue;
      if (
        isRecord(operation.requestBody) &&
        isRecord(operation.requestBody.content)
      ) {
        for (const media of Object.values(operation.requestBody.content)) {
          if (isRecord(media)) {
            requestSchemas.push([`${path} ${method}`, media.schema]);
          }
        }
      }
    }
  }

  for (const schema of collectResponseSchemas(document)) {
    walkSchema(
      schema,
      (node) => {
        if (
          (node.type === 'object' || isRecord(node.properties)) &&
          node.additionalProperties !== true
        ) {
          throw new Error(
            `${label} has a closed public response object schema`,
          );
        }
      },
      componentSchemas,
    );
  }
  for (const [boundary, schema] of requestSchemas) {
    walkSchema(
      schema,
      (node) => {
        if (
          node.type === 'object' &&
          node.additionalProperties !== false &&
          !(isRecord(node.patternProperties) && !isRecord(node.properties))
        ) {
          throw new Error(
            `${label} has an open request object schema at ${boundary}`,
          );
        }
      },
      componentSchemas,
    );
  }
}

/** @param {OpenApiDocument} document @returns {OpenApiDocument} */
function withExtensibleResponseSchemas(document) {
  const copy = structuredClone(document);
  const components = isRecord(copy.components) ? copy.components : {};
  const componentSchemas = isRecord(components.schemas)
    ? components.schemas
    : {};
  for (const schema of collectResponseSchemas(copy)) {
    walkSchema(
      schema,
      (node) => {
        if (node.type === 'object' || isRecord(node.properties)) {
          node.additionalProperties = true;
        }
      },
      componentSchemas,
    );
  }
  return copy;
}

/** @param {unknown} value @param {boolean} [preservePropertyNames] @returns {unknown} */
function withoutDocumentation(value, preservePropertyNames = false) {
  if (Array.isArray(value)) {
    return value.map((item) => withoutDocumentation(item));
  }
  if (!isRecord(value)) return value;
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (preservePropertyNames || !DOC_FIELDS.has(key)) {
      copy[key] = withoutDocumentation(child, key === 'properties');
    }
  }
  return copy;
}

/** @param {OpenApiDocument} document @returns {OpenApiDocument} */
function withoutVersion(document) {
  const copy = structuredClone(document);
  delete copy.info.version;
  return copy;
}

/** @param {string} previous @param {string} candidate @param {boolean} contractChanged */
function validateVersionBump(previous, candidate, contractChanged) {
  const [previousMajor, previousMinor, previousPatch] = parseVersion(previous);
  const [candidateMajor, candidateMinor, candidatePatch] =
    parseVersion(candidate);
  const valid = contractChanged
    ? candidateMajor === previousMajor &&
      candidateMinor === previousMinor + 1 &&
      candidatePatch === 0
    : candidateMajor === previousMajor &&
      candidateMinor === previousMinor &&
      candidatePatch === previousPatch + 1;
  if (!valid) {
    const bump = contractChanged ? 'next minor' : 'next patch';
    throw new Error(
      `/v${previousMajor} contract ${candidate} must be the ${bump} after ${previous}`,
    );
  }
}

/** @param {string} changelog @param {string} version */
function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

/** @param {string} changelog */
function latestChangelogVersion(changelog) {
  const match = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  return match?.[1];
}

/** @param {OpenApiDocument} document @param {number} from @param {number} to @returns {OpenApiDocument} */
function withPathMajor(document, from, to) {
  const copy = structuredClone(document);
  /** @type {Record<string, unknown>} */
  const paths = {};
  for (const [path, item] of Object.entries(copy.paths)) {
    paths[path.replace(new RegExp(`^/v${from}(?=/)`), `/v${to}`)] = item;
  }
  copy.paths = paths;
  return copy;
}

/** @param {string} changelog @param {number} previous @param {number} next @param {string} version */
function requireMigrationNotice(changelog, previous, next, version) {
  const section = sectionFor(changelog, version);
  const start = section.indexOf('### Migration');
  const migrationText = start < 0 ? '' : section.slice(start + 14);
  const nextHeading = migrationText.search(/^### /m);
  const migration =
    nextHeading < 0 ? migrationText : migrationText.slice(0, nextHeading);
  if (
    start < 0 ||
    !migration.includes(`/v${previous}`) ||
    !migration.includes(`/v${next}`)
  ) {
    throw new Error(
      `CHANGELOG.md ${version} entry needs a Migration section describing /v${previous} to /v${next}`,
    );
  }
}

/** @param {string} baseRoot @param {string} candidateRoot @param {string} changelogPath @param {Date} [today] @returns {void} */
export function checkRelease(
  baseRoot,
  candidateRoot,
  changelogPath,
  today = new Date(),
) {
  const candidateSpecs = listVersionedSpecs(candidateRoot);
  if (candidateSpecs.size === 0) {
    throw new Error('No versioned OpenAPI documents found under openapi/');
  }
  const changelog = readFileSync(changelogPath, 'utf8');
  const latestMajor = Math.max(...candidateSpecs.keys());
  const latestDocument = candidateSpecs.get(latestMajor);
  if (!latestDocument) throw new Error(`Missing /v${latestMajor} contract`);
  const latestVersion = validateVersionedDocument(
    latestDocument,
    `openapi/v${latestMajor}.json`,
  );
  const alias = readDocument(join(candidateRoot, 'openapi.json'));
  if (!isDeepStrictEqual(alias, latestDocument)) {
    throw new Error('openapi.json must alias the latest versioned contract');
  }
  if (latestChangelogVersion(changelog) !== latestVersion) {
    throw new Error(
      `CHANGELOG.md latest entry must match public contract ${latestVersion}`,
    );
  }

  for (const [major, document] of candidateSpecs) {
    const label = `openapi/v${major}.json`;
    const version = validateVersionedDocument(document, label);
    if (parseVersion(version)[0] !== major) {
      throw new Error(`${label} info.version must use major ${major}`);
    }
    validateSchemaPolicies(document, label);
  }

  let baseSpecs = listVersionedSpecs(baseRoot);
  const bootstrap = baseSpecs.size === 0;
  if (bootstrap) {
    const legacyPath = join(baseRoot, 'openapi.json');
    baseSpecs = new Map([[1, readDocument(legacyPath)]]);
  }

  const retiring = checkMajorLifecycle(
    baseRoot,
    candidateRoot,
    candidateSpecs,
    new Set(baseSpecs.keys()),
    today,
  );

  for (const [major, baseDocument] of baseSpecs) {
    const candidateDocument = candidateSpecs.get(major);
    if (!candidateDocument && retiring.has(major)) continue;
    if (!candidateDocument) {
      throw new Error(`Candidate removes supported /v${major} contract`);
    }
    const candidateVersion = validateVersionedDocument(
      candidateDocument,
      `openapi/v${major}.json`,
    );
    const baseVersion = isRecord(baseDocument.info)
      ? baseDocument.info.version
      : undefined;
    const breaks = findBreakingChanges(
      withExtensibleResponseSchemas(baseDocument),
      withExtensibleResponseSchemas(candidateDocument),
    );
    if (breaks.length > 0) {
      throw new Error(
        `Breaking changes to supported /v${major} contract:\n${breaks.map((change) => `- ${change.text}`).join('\n')}`,
      );
    }

    if (!bootstrap && typeof baseVersion === 'string') {
      const contractChanged = !isDeepStrictEqual(
        withoutDocumentation(withoutVersion(baseDocument)),
        withoutDocumentation(withoutVersion(candidateDocument)),
      );
      const documentChanged = !isDeepStrictEqual(
        withoutVersion(baseDocument),
        withoutVersion(candidateDocument),
      );
      if (documentChanged || candidateVersion !== baseVersion) {
        validateVersionBump(baseVersion, candidateVersion, contractChanged);
        sectionFor(changelog, candidateVersion);
      }
    } else {
      sectionFor(changelog, candidateVersion);
    }
  }

  const previousMajors = [...baseSpecs.keys()].sort((a, b) => a - b);
  const previousMajor = previousMajors.at(-1) ?? 0;
  const newMajors = [...candidateSpecs.keys()].filter(
    (major) => !baseSpecs.has(major),
  );
  if (bootstrap) {
    if (
      candidateSpecs.size !== 1 ||
      latestMajor !== 1 ||
      latestVersion !== '1.0.0'
    ) {
      throw new Error('The initial published contract must be /v1 at 1.0.0');
    }
  } else if (newMajors.length > 0) {
    if (newMajors.length !== 1 || newMajors[0] !== previousMajor + 1) {
      throw new Error('A release may introduce only the next API major');
    }
    const nextMajor = newMajors[0];
    const nextDocument = candidateSpecs.get(nextMajor);
    const previousDocument = candidateSpecs.get(previousMajor);
    if (!nextDocument || !previousDocument || latestMajor !== nextMajor) {
      throw new Error(
        `A new /v${nextMajor} release must preserve /v${previousMajor}`,
      );
    }
    const nextVersion = validateVersionedDocument(
      nextDocument,
      `openapi/v${nextMajor}.json`,
    );
    if (nextVersion !== `${nextMajor}.0.0`) {
      throw new Error(
        `A new /v${nextMajor} major must start at ${nextMajor}.0.0`,
      );
    }
    const changes = findBreakingChanges(
      withExtensibleResponseSchemas(
        withPathMajor(previousDocument, previousMajor, 1),
      ),
      withExtensibleResponseSchemas(withPathMajor(nextDocument, nextMajor, 1)),
    );
    if (changes.length === 0) {
      throw new Error(
        `New /v${nextMajor} contract has no breaking contract change after normalizing the URI major`,
      );
    }
    requireMigrationNotice(changelog, previousMajor, nextMajor, nextVersion);
  } else if (candidateSpecs.size !== baseSpecs.size - retiring.size) {
    throw new Error(
      'Candidate versioned OpenAPI set does not match its baseline',
    );
  }

  process.stdout.write(
    `Public API release contract passed: /v${latestMajor} at ${latestVersion}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    const [baseRoot, candidateRoot, changelogPath, ...extraArgs] = args;
    if (!baseRoot || !candidateRoot || !changelogPath || extraArgs.length > 0) {
      throw new Error(
        'Usage: node scripts/ci/api-compatibility/check-release.mjs <base-repository> <candidate-repository> <candidate-changelog>',
      );
    }
    checkRelease(baseRoot, candidateRoot, changelogPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
