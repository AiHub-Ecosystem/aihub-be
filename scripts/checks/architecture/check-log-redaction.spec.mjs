import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectLogRedactionFailures } from './check-log-redaction.mjs';

const ROOT = join('fixture-root');

/**
 * Runs the gate over in-memory fixtures: `files` maps paths under the fixture
 * root to their source text, and nothing touches the disk.
 * @param {Record<string, string>} sources path relative to the fixture root
 * @returns {string[]}
 */
function check(sources) {
  const files = Object.keys(sources).map((path) =>
    join(ROOT, ...path.split('/')),
  );
  const { failures } = collectLogRedactionFailures({
    root: ROOT,
    files,
    readSource: (file) => {
      const key = file
        .slice(ROOT.length + 1)
        .split('\\')
        .join('/');
      assert.ok(key in sources, `unexpected read: ${key}`);
      return sources[key];
    },
  });
  return failures;
}

const SRC_FILE = 'src/modules/example/infrastructure/example.adapter.ts';

await test('a log call passing a named secret-bearing identifier fails', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function wipe(logger: { error(message: string): void }, keyHash: string) {',
      '  logger.error({ keyHash });',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /example\.adapter\.ts:2/);
  assert.match(failures[0], /keyHash/);
});

await test('pino, console and Nest Logger receivers are all in scope', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(Logger: { error(message: string): void }, apiKey: string) {',
      '  console.log(apiKey);',
      '  Logger.error(apiKey);',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 2);
});

await test('a this.logger receiver is in scope and the line is reported', () => {
  const failures = check({
    [SRC_FILE]: [
      'class Demo {',
      '  private readonly logger = { warn(message: string): void {} };',
      '  warn(password: string) {',
      '    this.logger.warn(password);',
      '  }',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /:4/);
});

await test('a redact-ok escape with a reason is accepted', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { error(message: string): void }, keyHash: string) {',
      '  logger.error(keyHash); // redact-ok: the value is already hashed beyond recovery',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('a redact-ok marker without a reason still fails', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { error(message: string): void }, keyHash: string) {',
      '  logger.error(keyHash); // redact-ok:',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 1);
});

await test('spec files are excluded: they may assert on captured log output', () => {
  const failures = check({
    'src/modules/example/infrastructure/example.adapter.spec.ts': [
      'it(',
      '  logs the key hash,',
      '  () => {',
      '    expect(captured).toContain(keyHash);',
      '  },',
      ');',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('the observability module is excluded: it constructs the records', () => {
  const failures = check({
    'src/common/observability/request-logger.ts': [
      'export function line(apiKey: string) {',
      '  console.log(apiKey);',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('non-logger receivers are not flagged', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(cache: { set(key: string, value: string): void }, parse(input: string): string, apiKey: string) {',
      '  cache.set("k", apiKey);',
      '  parse(apiKey);',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('non-secret identifiers in log calls are not flagged', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { info(record: object): void }, requestId: string, organizationId: string, apiKeyId: string) {',
      '  logger.info({ requestId, organizationId, apiKeyId });',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('analogue identifiers are flagged, and the PR documents the list', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { info(record: object): void }, accessToken: string, sessionCookie: string, requestBody: object, userAssertion: string) {',
      '  logger.info({ accessToken });',
      '  logger.info({ sessionCookie });',
      '  logger.info({ requestBody });',
      '  logger.info({ userAssertion });',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 4);
});

await test('request.body and response.body are flagged as property accesses', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { error(record: object): void }, request: { body: object }, response: { body: object }) {',
      '  logger.error(request.body);',
      '  logger.error(response.body);',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 2);
});

await test('arguments spanning several lines are scanned from the call line', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { error(record: object): void }, input: { refreshToken: string }) {',
      '  logger.error({',
      '    event: "refresh_failed",',
      '    credential: input.refreshToken,',
      '  });',
      '}',
    ].join('\n'),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /:2/);
  assert.match(failures[0], /refreshToken/);
});

await test('a redact-ok marker on the line after a single-line call is accepted', () => {
  const failures = check({
    [SRC_FILE]: [
      'export function demo(logger: { error(message: string): void }, keyHash: string) {',
      '  logger.error(keyHash);',
      '  // redact-ok: the value is already hashed beyond recovery',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});

await test('files outside src are not scanned', () => {
  const failures = check({
    'scripts/example.ts': [
      'export function demo(logger: { error(message: string): void }, apiKey: string) {',
      '  logger.error(apiKey);',
      '}',
    ].join('\n'),
  });
  assert.deepEqual(failures, []);
});
