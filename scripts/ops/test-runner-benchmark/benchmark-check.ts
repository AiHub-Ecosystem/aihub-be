import assert from 'node:assert/strict';

import { median } from './benchmark';

assert.equal(median([9, 1, 5]), 5);
assert.equal(median([10, 2, 8, 4]), 6);
assert.throws(() => median([]), /median requires at least one sample/);

process.stdout.write('Test runner benchmark helper checks passed.\n');
