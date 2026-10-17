import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATION_CATALOG } from './operation-catalog';

// The endpoint table in the integration guide is what a customer sets client
// timeouts and upload sizes from. The catalog is the source; a change to a
// budget or a body limit that leaves the table behind fails here. The JSON
// grading budget went from 30 to 60 seconds while the guide kept 30.
const GUIDE = readFileSync(
  join(__dirname, '../../docs/integration-guide.md'),
  'utf8',
);

const UNIT_BYTES = { KB: 1024, MiB: 1024 * 1024 } as const;

function documentedLimits(path: string): { bytes: number; ms: number } {
  const row = GUIDE.split('\n').find((line) =>
    line.startsWith(`| \`${path}\``),
  );
  const match = row?.match(/\|\s*(\d+)\s*(KB|MiB)\s*\|\s*(\d+)s\s*\|\s*$/);
  if (match === null || match === undefined) {
    throw new Error(`integration guide has no limits row for ${path}`);
  }
  const [, size, unit, seconds] = match;
  return {
    bytes: Number(size) * UNIT_BYTES[unit as keyof typeof UNIT_BYTES],
    ms: Number(seconds) * 1_000,
  };
}

describe('integration guide endpoint table', () => {
  it.each(Object.values(OPERATION_CATALOG).map((op) => [op.path, op]))(
    'states the catalog body limit and budget for %s',
    (path, op) => {
      expect(documentedLimits(path)).toEqual({
        bytes: op.maxBodyBytes,
        ms: op.timeoutMs,
      });
    },
  );
});
