import { readFileSync } from 'node:fs';
import process from 'node:process';

import { Validator } from '@seriousme/openapi-schema-validator';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {string} path @returns {unknown} */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const majors = readJson('openapi/majors.json');
if (!Array.isArray(majors)) {
  console.error('openapi/majors.json is not a list of majors');
  process.exit(1);
}
/** @type {number[]} */
const supported = [];
for (const entry of majors) {
  if (isRecord(entry) && entry.status === 'supported') {
    supported.push(Number(entry.major));
  }
}
const newest = Math.max(...supported);

const documents = [
  ...supported.map((major) => `openapi/v${major}.json`),
  'openapi.json',
];

for (const path of documents) {
  const validator = new Validator();
  const result = await validator.validate(path);

  if (!result.valid) {
    console.error(`${path} failed OpenAPI 3.1 validation:`);
    console.error(JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  if (validator.version !== '3.1') {
    console.error(
      `${path} validated as version ${validator.version}, expected 3.1`,
    );
    process.exit(1);
  }
}

const versioned = readJson(`openapi/v${newest}.json`);
const latest = readJson('openapi.json');
if (
  !isRecord(versioned) ||
  !isRecord(latest) ||
  !isRecord(versioned.info) ||
  !isRecord(latest.info) ||
  versioned.info.version !== latest.info.version
) {
  console.error(`openapi.json is not the latest /v${newest} contract alias`);
  process.exit(1);
}

console.log(`${documents.join(', ')} are valid OpenAPI 3.1 documents`);
