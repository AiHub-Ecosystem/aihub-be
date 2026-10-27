import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const script = path.join(
  repositoryRoot,
  'scripts/ops/monitoring/update-alert-rules-fingerprint.mjs',
);

function run(file, check = false) {
  return spawnSync(
    process.execPath,
    [script, '--file', file, ...(check ? ['--check'] : [])],
    {
      encoding: 'utf8',
    },
  );
}

void test('the tracked alert rules carry their current fingerprint', () => {
  const result = spawnSync(process.execPath, [script, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

void test('expression, label, and annotation edits invalidate the loaded-file fingerprint', () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'aihub-rule-fingerprint-'),
  );
  const file = path.join(directory, 'alert.rules.yml');
  try {
    writeFileSync(
      file,
      [
        'groups:',
        '  - name: test',
        '    rules:',
        '      - alert: Example',
        '        expr: up == 0',
        '        labels:',
        '          severity: warning',
        '        annotations:',
        '          summary: target down',
        '      - record: aihub:alert_rules_fingerprint',
        '        expr: vector(1)',
        '        labels:',
        '          rules_sha256: "0000000000000000000000000000000000000000000000000000000000000000"',
        '',
      ].join('\n'),
    );
    assert.equal(run(file).status, 0);
    let previous = readFileSync(file, 'utf8').match(
      /rules_sha256: "([0-9a-f]{64})"/,
    )[1];
    assert.equal(run(file, true).status, 0);

    for (const [before, after] of [
      ['up == 0', 'up == 1'],
      ['severity: warning', 'severity: critical'],
      ['summary: target down', 'summary: target changed'],
    ]) {
      const content = readFileSync(file, 'utf8');
      writeFileSync(file, content.replace(before, after));
      assert.equal(run(file, true).status, 1);
      assert.equal(run(file).status, 0);
      const current = readFileSync(file, 'utf8').match(
        /rules_sha256: "([0-9a-f]{64})"/,
      )[1];
      assert.notEqual(current, previous);
      previous = current;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
