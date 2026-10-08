import process from 'node:process';

import { Validator } from '@seriousme/openapi-schema-validator';

const validator = new Validator();
const result = await validator.validate('./openapi.json');

if (!result.valid) {
  console.error('openapi.json failed OpenAPI 3.1 validation:');
  console.error(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

if (validator.version !== '3.1') {
  console.error(
    `openapi.json validated as version ${validator.version}, expected 3.1`,
  );
  process.exit(1);
}

console.log('openapi.json is valid OpenAPI 3.1');
