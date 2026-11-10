import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderCodeRabbitConfig } from './coderabbit-config.mjs';

const rootDir = resolve(process.cwd());
const outputPath = resolve(rootDir, '.coderabbit.yaml');
const expected = renderCodeRabbitConfig(rootDir);

if (process.argv.includes('--check')) {
  let actual: string;
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch {
    actual = '';
  }
  if (actual !== expected) {
    console.error(
      'CodeRabbit config is stale; run bun run generate:coderabbit-config.',
    );
    process.exitCode = 1;
  } else {
    console.log('coderabbit-config: OK');
  }
} else {
  writeFileSync(outputPath, expected);
  console.log(`wrote ${outputPath}`);
}
