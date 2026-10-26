/// <reference types="node" />

import assert from 'node:assert/strict';
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

/** @param {Record<string, OpenApiDocument>} specs @returns {SpecFiles} */
function versionedFiles(specs) {
  const files = /** @type {SpecFiles} */ ({});
  const latest = Object.entries(specs)
    .sort(([left], [right]) => Number(left) - Number(right))
    .at(-1);
  if (!latest) throw new Error('At least one major contract is required');
  for (const [major, spec] of Object.entries(specs)) {
    files[`openapi/v${major}.json`] = spec;
  }
  files['openapi.json'] = latest[1];
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
    versionedFiles({ 2: breakingV2 }),
    changelog,
  );

  assert.throws(
    () =>
      checkRelease(
        missingV1Roots.baseRoot,
        missingV1Roots.candidateRoot,
        missingV1Roots.changelogPath,
      ),
    /removes supported \/v1 contract/,
  );
});

void test('rejects response schemas that are closed or request schemas that are open', (t) => {
  const base = document('1.0.0');
  const closedResponse = document('1.0.0');
  const closedSchema = structuredClone(responseSchema(closedResponse, 1));
  closedSchema.additionalProperties = false;
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
