import { readFileSync } from 'node:fs';
import process from 'node:process';

import { Validator } from '@seriousme/openapi-schema-validator';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

for (const path of ['openapi/v1.json', 'openapi.json']) {
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

const versioned = /** @type {unknown} */ (
  JSON.parse(readFileSync('openapi/v1.json', 'utf8'))
);
const latest = /** @type {unknown} */ (
  JSON.parse(readFileSync('openapi.json', 'utf8'))
);
if (
  !isRecord(versioned) ||
  !isRecord(latest) ||
  !isRecord(versioned.info) ||
  !isRecord(latest.info) ||
  versioned.info.version !== latest.info.version
) {
  console.error('openapi.json is not the latest /v1 contract alias');
  process.exit(1);
}

console.log('openapi/v1.json and openapi.json are valid OpenAPI 3.1 documents');
