/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRelease } from '../../scripts/ci/api-compatibility/check-release.mjs';

/** @typedef {{type?: string, enum?: string[], properties?: Record<string, Schema>, required?: string[], additionalProperties?: boolean, $ref?: string}} Schema */
/** @typedef {{schema: Schema}} MediaType */
/** @typedef {{description: string, content?: Record<string, MediaType>}} ApiResponse */
/** @typedef {{responses: Record<string, ApiResponse>, requestBody?: {content: Record<string, MediaType>}}} Operation */
/** @typedef {{get?: Operation, post?: Operation}} PathItem */
/** @typedef {{openapi: string, info: {title: string, version: string}, paths: Record<string, PathItem>, components: {responses: Record<string, unknown>, schemas?: Record<string, Schema>}}} OpenApiDocument */
/** @typedef {Record<string, unknown>} SpecFiles */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP_ROOT = join(ROOT, 'temp');

/** @param {string} version @param {number} [major] @returns {OpenApiDocument} */
function document(version, major = 1) {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['ready'] },
    },
    required: ['id', 'status'],
    additionalProperties: true,
  };
  const requestSchema = {
    type: 'object',
    properties: { limit: { type: 'integer' } },
    additionalProperties: false,
  };
  return {
    openapi: '3.1.0',
    info: { title: 'AIHUB API', version },
    paths: {
      [`/v${major}/items`]: {
        get: {
          responses: {
            200: {
              description: 'Items',
              content: { 'application/json': { schema } },
            },
          },
        },
        post: {
          requestBody: {
            content: { 'application/json': { schema: requestSchema } },
          },
          responses: { 204: { description: 'Accepted' } },
        },
      },
    },
    components: { responses: {} },
  };
}

/** @param {OpenApiDocument} spec @param {number} major @returns {Schema} */
function responseSchema(spec, major) {
  const path = spec.paths[`/v${major}/items`];
  const response = path?.get?.responses['200'];
  const schema = response?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`Missing /v${major} response schema`);
  return schema;
}

/** @param {OpenApiDocument} spec @param {number} major @returns {Schema} */
function requestSchema(spec, major) {
  const path = spec.paths[`/v${major}/items`];
  const schema = path?.post?.requestBody?.content['application/json']?.schema;
  if (!schema) throw new Error(`Missing /v${major} request schema`);
  return schema;
}

/** @param {import('node:test').TestContext} t @param {SpecFiles} baseDocs @param {SpecFiles} candidateDocs @param {string} changelog */
function setup(t, baseDocs, candidateDocs, changelog) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEMP_ROOT, 'api-compatibility-release-'));
  const baseRoot = join(root, 'base');
  const candidateRoot = join(root, 'candidate');
  mkdirSync(join(baseRoot, 'openapi'), { recursive: true });
  mkdirSync(join(candidateRoot, 'openapi'), { recursive: true });
  for (const [name, value] of Object.entries(baseDocs)) {
    const content = JSON.stringify(value);
    if (content === undefined) throw new Error(`Cannot serialize ${name}`);
    writeFileSync(join(baseRoot, name), content);
  }
  for (const [name, value] of Object.entries(candidateDocs)) {
    const content = JSON.stringify(value);
    if (content === undefined) throw new Error(`Cannot serialize ${name}`);
    writeFileSync(join(candidateRoot, name), content);
  }
  const changelogPath = join(candidateRoot, 'CHANGELOG.md');
  writeFileSync(changelogPath, changelog);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    try {
      rmdirSync(TEMP_ROOT);
    } catch (error) {
      if (
        !isRecord(error) ||
        !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))
      ) {
        throw error;
      }
    }
  });
  return { baseRoot, candidateRoot, changelogPath };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {number} major */
function releasedAt(major) {
  return `${2025 + major}-01-01T00:00:00.000Z`;
}

/**
 * A valid lifecycle for these supported majors: each is released a year after
 * the one before, and each superseded one sunsets 12 months after its successor.
 * @param {Record<string, OpenApiDocument>} specs
 * @returns {Record<string, unknown>[]}
 */
function supportedMajors(specs) {
  const majors = Object.keys(specs)
    .map(Number)
    .sort((left, right) => left - right);
  return majors.map((major, index) => {
    const successor = majors[index + 1];
    return {
      major,
      contractVersion: specs[major]?.info.version,
      status: 'supported',
      releasedAt: releasedAt(major),
      ...(successor === undefined
        ? {}
        : {
            sunset: {
              successor,
              deprecationAt: releasedAt(successor),
              sunsetAt: releasedAt(successor + 1),
            },
          }),
    };
  });
}

/** @param {Record<string, OpenApiDocument>} specs @param {Record<string, unknown>[]} [majors] @returns {SpecFiles} */
function versionedFiles(specs, majors = supportedMajors(specs)) {
  const files = /** @type {SpecFiles} */ ({});
  const latest = Object.entries(specs)
    .sort(([left], [right]) => Number(left) - Number(right))
    .at(-1);
  if (!latest) throw new Error('At least one major contract is required');
  for (const [major, spec] of Object.entries(specs)) {
    files[`openapi/v${major}.json`] = spec;
  }
  files['openapi.json'] = latest[1];
  files['openapi/majors.json'] = majors;
  return files;
}

void test('bootstraps public contract 1.0.0 from the current unversioned OpenAPI document', (t) => {
  const legacy = document('0.1.0');
  const baseline = document('1.0.0');
  const roots = setup(
    t,
    { 'openapi.json': legacy },
    versionedFiles({ 1: baseline }),
    '# AIHUB Public API Changelog\n\n## [1.0.0] — `/v1` baseline\n',
  );

  assert.doesNotThrow(() =>
    checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
  );
});

void test('normalizes old response closure flags before checking the v1 baseline', (t) => {
  const legacy = document('0.1.0');
  const baseline = document('1.0.0');
  for (const [spec, additionalProperties] of [
    [legacy, false],
    [baseline, true],
  ]) {
    const schema = responseSchema(spec, 1);
    schema.additionalProperties = additionalProperties;
    schema.properties.data = {
      anyOf: [
        {
          type: 'object',
          properties: { configured: { type: 'boolean' } },
          additionalProperties,
        },
        {
          type: 'object',
          properties: { unconfigured: { type: 'boolean' } },
          additionalProperties,
        },
      ],
    };
  }
  const roots = setup(
    t,
    { 'openapi.json': legacy },
    versionedFiles({ 1: baseline }),
    '# AIHUB Public API Changelog\n\n## [1.0.0] — `/v1` baseline\n',
  );

  assert.doesNotThrow(() =>
    checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
  );
});

void test('accepts pnpm’s forwarded argument separator before release paths', (t) => {
  const legacy = document('0.1.0');
  const baseline = document('1.0.0');
  const roots = setup(
    t,
    { 'openapi.json': legacy },
    versionedFiles({ 1: baseline }),
    '# AIHUB Public API Changelog\n\n## [1.0.0] — `/v1` baseline\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts/ci/api-compatibility/check-release.mjs'),
      '--',
      roots.baseRoot,
      roots.candidateRoot,
      roots.changelogPath,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Public API release contract passed/);
});

void test('accepts a compatible response-property addition with a minor version and changelog entry', (t) => {
  const base = document('1.0.0');
  const candidate = document('1.1.0');
  const properties = responseSchema(candidate, 1).properties;
  if (!properties) throw new Error('Missing response properties');
  properties.display_name = { type: 'string' };
  const roots = setup(
    t,
    versionedFiles({ 1: base }),
    versionedFiles({ 1: candidate }),
    '# AIHUB Public API Changelog\n\n## [1.1.0]\n\n### Added\n- Optional response property.\n',
  );

  assert.doesNotThrow(() =>
    checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
  );
});

void test('counts additions inside a response property named summary as contract changes', (t) => {
  const base = document('1.0.0');
  const candidate = document('1.1.0');
  const baseProperties = responseSchema(base, 1).properties;
  const candidateProperties = responseSchema(candidate, 1).properties;
  if (!baseProperties || !candidateProperties) {
    throw new Error('Missing response properties');
  }
  baseProperties.summary = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: true,
  };
  candidateProperties.summary = structuredClone(baseProperties.summary);
  const summary = candidateProperties.summary;
  if (!summary || !summary.properties) {
    throw new Error('Missing summary response properties');
  }
  summary.properties.confidence = { type: 'number' };
  const roots = setup(
    t,
    versionedFiles({ 1: base }),
    versionedFiles({ 1: candidate }),
    '# AIHUB Public API Changelog\n\n## [1.1.0]\n\n### Added\n- Optional summary property.\n',
  );

  assert.doesNotThrow(() =>
    checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
  );
});

void test('rejects a breaking change to a supported major despite an intentional declaration', (t) => {
  const base = document('1.0.0');
  const candidate = document('1.1.0');
  const schema = responseSchema(candidate, 1);
  if (!schema.properties) throw new Error('Missing response properties');
  delete schema.properties.id;
  schema.required = ['status'];
  const roots = setup(
    t,
    versionedFiles({ 1: base }),
    versionedFiles({ 1: candidate }),
    '# AIHUB Public API Changelog\n\n## [1.1.0]\n\n### Changed\n- Breaking change.\n',
  );

  assert.throws(
    () =>
      checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
    /Breaking changes to supported \/v1 contract/,
  );
});

void test('accepts a new major only with a real break, a preserved prior major, and a migration notice', (t) => {
  const v1 = document('1.0.0');
  const v2 = document('2.0.0', 2);
  const schema = responseSchema(v2, 2);
  if (!schema.properties) throw new Error('Missing response properties');
  delete schema.properties.id;
  schema.required = ['status'];
  const roots = setup(
    t,
    versionedFiles({ 1: v1 }),
    versionedFiles({ 1: v1, 2: v2 }),
    '# AIHUB Public API Changelog\n\n## [2.0.0]\n\n### Migration\nMigrate from `/v1` to `/v2` before the published sunset.\n',
  );

  assert.doesNotThrow(() =>
    checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
  );
});

void test('rejects an identical new major and a new major that drops the prior contract', (t) => {
  const v1 = document('1.0.0');
  const identicalV2 = document('2.0.0', 2);
  const changelog =
    '# AIHUB Public API Changelog\n\n## [2.0.0]\n\n### Migration\nMigrate from `/v1` to `/v2`.\n';
  const duplicateRoots = setup(
    t,
    versionedFiles({ 1: v1 }),
    versionedFiles({ 1: v1, 2: identicalV2 }),
    changelog,
  );

  assert.throws(
    () =>
      checkRelease(
        duplicateRoots.baseRoot,
        duplicateRoots.candidateRoot,
        duplicateRoots.changelogPath,
      ),
    /no breaking contract change/,
  );

  const breakingV2 = document('2.0.0', 2);
  const schema = responseSchema(breakingV2, 2);
  if (!schema.properties) throw new Error('Missing response properties');
  delete schema.properties.id;
  schema.required = ['status'];
  const missingNoticeRoots = setup(
    t,
    versionedFiles({ 1: v1 }),
    versionedFiles({ 1: v1, 2: breakingV2 }),
    '# AIHUB Public API Changelog\n\n## [2.0.0]\n\n### Changed\n- New major.\n',
  );
  assert.throws(
    () =>
      checkRelease(
        missingNoticeRoots.baseRoot,
        missingNoticeRoots.candidateRoot,
        missingNoticeRoots.changelogPath,
      ),
    /needs a Migration section/,
  );

  const missingV1Roots = setup(
    t,
    versionedFiles({ 1: v1 }),
    versionedFiles(
      { 2: breakingV2 },
      supportedMajors({ 1: v1, 2: breakingV2 }),
    ),
    changelog,
  );

  assert.throws(
    () =>
      checkRelease(
        missingV1Roots.baseRoot,
        missingV1Roots.candidateRoot,
        missingV1Roots.changelogPath,
      ),
    /Supported \/v1 has no openapi\/v1.json/,
  );
});

/** @param {Record<string, unknown>[]} majors @param {number} major @param {Record<string, unknown>} change */
function withMajor(majors, major, change) {
  return majors.map((entry) =>
    entry.major === major ? { ...entry, ...change } : entry,
  );
}

const V2_CHANGELOG = '# AIHUB Public API Changelog\n\n## [2.0.0]\n';
const V1_SUNSET = releasedAt(3);

void test('retires a major after its sunset and removes its document', (t) => {
  const specs = { 1: document('1.0.0'), 2: document('2.0.0', 2) };
  const retired = withMajor(supportedMajors(specs), 1, { status: 'retired' });
  const roots = setup(
    t,
    versionedFiles(specs),
    versionedFiles({ 2: specs[2] }, retired),
    V2_CHANGELOG,
  );

  assert.doesNotThrow(() =>
    checkRelease(
      roots.baseRoot,
      roots.candidateRoot,
      roots.changelogPath,
      new Date(V1_SUNSET),
    ),
  );
  assert.throws(
    () =>
      checkRelease(
        roots.baseRoot,
        roots.candidateRoot,
        roots.changelogPath,
        new Date(Date.parse(V1_SUNSET) - 1),
      ),
    /cannot be retired before its sunset/,
  );
});

void test('keeps a retired major retired and its document gone', (t) => {
  const specs = { 1: document('1.0.0'), 2: document('2.0.0', 2) };
  const retired = withMajor(supportedMajors(specs), 1, { status: 'retired' });
  const revived = setup(
    t,
    versionedFiles({ 2: specs[2] }, retired),
    versionedFiles(specs),
    V2_CHANGELOG,
  );
  assert.throws(
    () =>
      checkRelease(
        revived.baseRoot,
        revived.candidateRoot,
        revived.changelogPath,
      ),
    /Retired \/v1 cannot be supported again/,
  );

  const lingering = setup(
    t,
    versionedFiles(specs),
    versionedFiles(specs, retired),
    V2_CHANGELOG,
  );
  assert.throws(
    () =>
      checkRelease(
        lingering.baseRoot,
        lingering.candidateRoot,
        lingering.changelogPath,
      ),
    /openapi\/v1.json is not a supported major/,
  );
});

void test('holds a superseded major for 12 months and never moves its sunset earlier', (t) => {
  const specs = { 1: document('1.0.0'), 2: document('2.0.0', 2) };
  const majors = supportedMajors(specs);
  const sunset = /** @type {{sunset: Record<string, unknown>}} */ (majors[0])
    .sunset;
  const early = withMajor(majors, 1, {
    sunset: { ...sunset, sunsetAt: '2027-12-31T00:00:00.000Z' },
  });

  const shortRoots = setup(
    t,
    versionedFiles(specs),
    versionedFiles(specs, early),
    V2_CHANGELOG,
  );
  assert.throws(
    () =>
      checkRelease(
        shortRoots.baseRoot,
        shortRoots.candidateRoot,
        shortRoots.changelogPath,
      ),
    /at least 12 months after \/v2 is released/,
  );

  const extended = withMajor(majors, 1, {
    sunset: { ...sunset, sunsetAt: '2028-04-01T00:00:00.000Z' },
  });
  const extendRoots = setup(
    t,
    versionedFiles(specs),
    versionedFiles(specs, extended),
    V2_CHANGELOG,
  );
  assert.doesNotThrow(() =>
    checkRelease(
      extendRoots.baseRoot,
      extendRoots.candidateRoot,
      extendRoots.changelogPath,
    ),
  );

  const pulledInRoots = setup(
    t,
    versionedFiles(specs, extended),
    versionedFiles(specs),
    V2_CHANGELOG,
  );
  assert.throws(
    () =>
      checkRelease(
        pulledInRoots.baseRoot,
        pulledInRoots.candidateRoot,
        pulledInRoots.changelogPath,
      ),
    /sunset can only move later/,
  );
});

void test('requires the lifecycle file to describe the documents it ships', (t) => {
  const specs = { 1: document('1.0.0'), 2: document('2.0.0', 2) };
  const majors = supportedMajors(specs);
  /** @type {[string, SpecFiles, RegExp][]} */
  const cases = [
    [
      'no sunset on a superseded major',
      versionedFiles(specs, withMajor(majors, 1, { sunset: undefined })),
      /Superseded \/v1 needs a published sunset/,
    ],
    [
      'a sunset on the newest major',
      versionedFiles(
        specs,
        withMajor(majors, 2, {
          sunset: /** @type {{sunset: unknown}} */ (majors[0]).sunset,
        }),
      ),
      /newest major \/v2 cannot have a sunset/,
    ],
    [
      'a contract version that differs from the document',
      versionedFiles(specs, withMajor(majors, 2, { contractVersion: '2.1.0' })),
      /openapi\/v2.json is 2.0.0 but openapi\/majors.json says 2.1.0/,
    ],
    [
      'no lifecycle file',
      Object.fromEntries(
        Object.entries(versionedFiles(specs)).filter(
          ([name]) => name !== 'openapi/majors.json',
        ),
      ),
      /Missing openapi\/majors.json/,
    ],
  ];
  for (const [label, candidate, error] of cases) {
    const roots = setup(t, versionedFiles(specs), candidate, V2_CHANGELOG);
    assert.throws(
      () =>
        checkRelease(roots.baseRoot, roots.candidateRoot, roots.changelogPath),
      error,
      label,
    );
  }
});

void test('rejects response schemas that are closed or request schemas that are open', (t) => {
  const base = document('1.0.0');
  const closedResponse = document('1.0.0');
  const closedSchema = structuredClone(responseSchema(closedResponse, 1));
  const closedProperties = closedSchema.properties;
  if (!closedProperties) throw new Error('Missing response properties');
  closedProperties.data = {
    type: 'object',
    properties: { id: { type: 'string' } },
    additionalProperties: false,
  };
  closedResponse.components.schemas = { ClosedResponse: closedSchema };
  const path = closedResponse.paths['/v1/items'];
  const response = path?.get?.responses['200'];
  const media = response?.content?.['application/json'];
  if (!media) throw new Error('Missing response media type');
  media.schema = { $ref: '#/components/schemas/ClosedResponse' };
  const responseRoots = setup(
    t,
    versionedFiles({ 1: base }),
    versionedFiles({ 1: closedResponse }),
    '# AIHUB Public API Changelog\n\n## [1.0.0]\n',
  );
  assert.throws(
    () =>
      checkRelease(
        responseRoots.baseRoot,
        responseRoots.candidateRoot,
        responseRoots.changelogPath,
      ),
    /closed public response object schema/,
  );

  const openRequest = document('1.0.0');
  requestSchema(openRequest, 1).additionalProperties = true;
  const requestRoots = setup(
    t,
    versionedFiles({ 1: base }),
    versionedFiles({ 1: openRequest }),
    '# AIHUB Public API Changelog\n\n## [1.0.0]\n',
  );
  assert.throws(
    () =>
      checkRelease(
        requestRoots.baseRoot,
        requestRoots.candidateRoot,
        requestRoots.changelogPath,
      ),
    /open request object schema/,
  );
});
