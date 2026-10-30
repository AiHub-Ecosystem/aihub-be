/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseChanges } from '../../scripts/ci/api-compatibility/check.mjs';

/** @typedef {{type?: string, properties?: Record<string, Schema>, required?: string[], enum?: string[], 'x-extensible-enum'?: string[], anyOf?: Schema[], items?: Schema, const?: string}} Schema */
/** @typedef {{schema: Schema}} MediaType */
/** @typedef {{content: Record<string, MediaType>}} ApiResponse */
/** @typedef {{responses: Record<string, ApiResponse>}} Operation */
/** @typedef {{get: Operation}} PathItem */
/** @typedef {{paths: Record<string, PathItem>, components: {responses: Record<string, ApiResponse>}}} OpenApiDocument */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const TEMP_ROOT = join(ROOT, 'temp');
const CHECKER = join(ROOT, 'scripts/ci/api-compatibility/check.mjs');
const BASELINE_PATH = join(
  ROOT,
  'scripts/ci/api-compatibility/fixtures/baseline.json',
);
const BASELINE = /** @type {OpenApiDocument} */ (
  JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
);
const OPENAPI = /** @type {OpenApiDocument} */ (
  JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8'))
);
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const API_BREAK_DECLARATION =
  'API-Breaking-Change: intentional\nAPI-Breaking-Change-Reason: remove field for v2 migration';

void test('validates the oasdiff change shape before reporting it', () => {
  assert.deepEqual(
    parseChanges('[{"level":2,"text":"response field removed"}]'),
    [{ level: 2, text: 'response field removed' }],
  );
  assert.throws(
    () => parseChanges('[{"level":2}]'),
    /unexpected breaking-change result/,
  );
  assert.throws(
    () => parseChanges('[{"level":1,"text":"non-breaking change"}]'),
    /unexpected breaking-change result/,
  );
});

/** @param {unknown} error */
function errorCode(error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

/** @param {(document: OpenApiDocument) => void} mutator */
function fixture(mutator) {
  const document = structuredClone(BASELINE);
  mutator(document);
  return document;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {OpenApiDocument | string} candidate
 * @param {string} [body]
 * @param {OpenApiDocument} [baseline]
 */
function runChecker(t, candidate, body = '', baseline = BASELINE) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEMP_ROOT, 'api-compatibility-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    try {
      rmdirSync(TEMP_ROOT);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) {
        throw error;
      }
    }
  });
  const basePath = join(dir, 'base.json');
  const candidatePath = join(dir, 'candidate.json');
  writeFileSync(basePath, JSON.stringify(baseline));
  writeFileSync(
    candidatePath,
    typeof candidate === 'string' ? candidate : JSON.stringify(candidate),
  );

  return spawnSync(process.execPath, [CHECKER, basePath, candidatePath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PR_BODY: body },
  });
}

void test('rejects a removed required response field even when declared intentional', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      const response =
        document.paths['/v1/items'].get.responses['200'].content[
          'application/json'
        ].schema;
      delete response.properties.id;
      response.required = ['status'];
    }),
    API_BREAK_DECLARATION,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Breaking API contract changes detected/);
});

void test('allows an additive optional response field', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      document.paths['/v1/items'].get.responses['200'].content[
        'application/json'
      ].schema.properties.display_name = { type: 'string' };
    }),
  );

  assert.equal(result.status, 0, result.stderr);
});

void test('allows an additive public route', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      document.paths['/v1/new'] = structuredClone(document.paths['/v1/items']);
    }),
  );

  assert.equal(result.status, 0, result.stderr);
});

void test('allows a new value in a response enum declared extensible', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      document.paths['/v1/items'].get.responses['400'].content[
        'application/json'
      ].schema.properties.code['x-extensible-enum'].push('NEW_ERROR');
    }),
  );

  assert.equal(result.status, 0, result.stderr);
});

void test('rejects a new value in a closed response enum', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      document.paths['/v1/items'].get.responses['200'].content[
        'application/json'
      ].schema.properties.status.enum.push('waiting');
    }),
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Breaking API contract changes detected/);
});

void test('rejects changing a closed response enum to extensible in a supported major', (t) => {
  const candidate = fixture((document) => {
    const status =
      document.paths['/v1/items'].get.responses['200'].content[
        'application/json'
      ].schema.properties.status;
    delete status.enum;
    status['x-extensible-enum'] = ['ready'];
  });
  const undeclared = runChecker(t, candidate);
  const declared = runChecker(t, candidate, API_BREAK_DECLARATION);

  assert.notEqual(undeclared.status, 0);
  assert.match(undeclared.stderr, /Breaking API contract changes detected/);
  assert.notEqual(declared.status, 0);
  assert.match(declared.stderr, /Breaking API contract changes detected/);
});

void test('does not let a declared intentional break bypass the supported-major gate', (t) => {
  const result = runChecker(
    t,
    fixture((document) => {
      const response =
        document.paths['/v1/items'].get.responses['200'].content[
          'application/json'
        ].schema;
      delete response.properties.id;
      response.required = ['status'];
    }),
    API_BREAK_DECLARATION,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Breaking API contract changes detected/);
});

void test('does not let an intentional-break declaration hide an invalid contract', (t) => {
  const result = runChecker(t, '{', API_BREAK_DECLARATION);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JSON|property|position/i);
});

void test('compares the generated OpenAPI document, including the existing tuple shapes', () => {
  const result = spawnSync(
    process.execPath,
    [CHECKER, join(ROOT, 'openapi.json'), join(ROOT, 'openapi.json')],
    { cwd: ROOT, encoding: 'utf8', env: process.env },
  );

  assert.equal(result.status, 0, result.stderr);
});

void test('marks error codes and Audit actions as extensible response enums', () => {
  const errorCode =
    OPENAPI.components.responses.Error400.content['application/json'].schema
      .properties.error.properties.code['x-extensible-enum'];
  const auditAction =
    OPENAPI.paths['/v1/organizations/{organization_id}/audit-events'].get
      .responses['200'].content['application/json'].schema.properties.data
      .properties.events.items.properties.action['x-extensible-enum'];

  assert.ok(errorCode.includes('INVALID_REQUEST'));
  assert.ok(auditAction.includes('organization.created'));
  assert.ok(auditAction.includes('api_key.revoked'));
});

void test('allows extending the generated Audit action response enum', (t) => {
  const candidate = structuredClone(OPENAPI);
  const action =
    candidate.paths['/v1/organizations/{organization_id}/audit-events'].get
      .responses['200'].content['application/json'].schema.properties.data
      .properties.events.items.properties.action;
  action['x-extensible-enum'].push('organization.deleted');
  action.anyOf?.push({ const: 'organization.deleted', type: 'string' });

  const result = runChecker(t, candidate, '', OPENAPI);

  assert.equal(result.status, 0, result.stderr);
});

void test('runs the versioned release checker against the pull request base or the last deployed revision', () => {
  assert.ok(WORKFLOW.includes('ref: ${{ steps.base.outputs.sha }}'));
  assert.ok(
    WORKFLOW.includes('workflows/cd.yml/runs?branch=main&status=success'),
  );
  assert.ok(WORKFLOW.includes('sha="${sha:-$PUSH_BEFORE}"'));
  assert.ok(
    WORKFLOW.includes(
      "if: github.event_name == 'pull_request' || (github.event_name == 'push' && github.event.before != '0000000000000000000000000000000000000000')",
    ),
  );
  assert.ok(WORKFLOW.includes('path: base-contract'));
  assert.ok(
    WORKFLOW.includes(
      'pnpm check:api-compatibility -- base-contract . CHANGELOG.md',
    ),
  );
  assert.ok(WORKFLOW.includes('run: pnpm test:api-compatibility'));
});
