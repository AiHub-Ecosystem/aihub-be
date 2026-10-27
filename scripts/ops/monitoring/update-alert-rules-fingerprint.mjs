#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const fileIndex = process.argv.indexOf('--file');
const file =
  fileIndex === -1
    ? path.resolve(scriptDirectory, '../../../ops/monitoring/alert.rules.yml')
    : path.resolve(process.argv[fileIndex + 1]);
const check = process.argv.includes('--check');
const source = await readFile(file, 'utf8');
const marker = /^([ \t]*rules_sha256: ")[0-9a-f]{64}(")(?=\r?$)/gm;
const matches = [...source.matchAll(marker)];

if (matches.length !== 1) {
  throw new Error('Expected exactly one rules_sha256 fingerprint in ' + file);
}

const expected = createHash('sha256')
  .update(
    source.replace(
      marker,
      (_, prefix, suffix) => prefix + '0'.repeat(64) + suffix,
    ),
  )
  .digest('hex');
const current = matches[0][0].match(/[0-9a-f]{64}/)[0];

if (check) {
  if (current !== expected) {
    console.error(
      'alert rules fingerprint is stale; run update-alert-rules-fingerprint.mjs',
    );
    process.exitCode = 1;
  }
} else if (current !== expected) {
  await writeFile(
    file,
    source.replace(marker, (_, prefix, suffix) => prefix + expected + suffix),
  );
}
