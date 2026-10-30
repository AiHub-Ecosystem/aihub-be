#!/usr/bin/env node
/**
 * Run `pnpm build`, then measure the compiled collector under the production
 * memory limit with:
 * docker run --rm --memory 768m --memory-swap 768m --cpus 1.5 --mount "type=bind,source=$(pwd),target=/repo" --workdir /repo node:22.23.2-bookworm-slim node --expose-gc scripts/ops/measure-public-api-major-usage-buffer.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{rows: readonly object[], unattributed: readonly object[], batch: number, dropped: {from: Date, through: Date} | null}} PublicApiMajorUsageWrite */
/** @typedef {{add: (environment: string, write: PublicApiMajorUsageWrite) => Promise<void>, snapshot: () => Promise<never>}} PublicApiMajorUsageRepositoryPort */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(import.meta.url);
const usageModule =
  /** @type {typeof import('../../src/modules/metering/application/public-api-major-usage')} */ (
    require(
      path.join(
        repositoryRoot,
        'dist/modules/metering/application/public-api-major-usage.js',
      ),
    )
  );
const { PublicApiMajorUsageBuffer, PUBLIC_API_MAJOR_USAGE_MAX_KEYS } =
  usageModule;
const flusherModule =
  /** @type {typeof import('../../src/modules/metering/application/public-api-major-usage-flusher')} */ (
    require(
      path.join(
        repositoryRoot,
        'dist/modules/metering/application/public-api-major-usage-flusher.js',
      ),
    )
  );
const { PublicApiMajorUsageFlusher } = flusherModule;
const MiB = 1024 * 1024;
const maxMemoryBytes = 768 * MiB;
const gc = /** @type {(() => void) | undefined} */ (
  Reflect.get(globalThis, 'gc')
);
assert.equal(typeof gc, 'function', 'run Node with --expose-gc');

function collectGarbage() {
  assert.ok(gc, 'run Node with --expose-gc');
  gc();
}

/** @param {number} count @returns {number} */
function measureDistinctKeys(count) {
  const buffer = new PublicApiMajorUsageBuffer();
  const at = new Date('2026-09-30T12:00:00Z');
  collectGarbage();
  const before = process.memoryUsage().heapUsed;
  for (let organization = 0; organization < count; organization += 1) {
    buffer.record({
      major: 1,
      organizationId: `growth_${organization}`,
      failed: false,
      callerKind: 'api-key',
      at,
    });
  }
  collectGarbage();
  const growth = process.memoryUsage().heapUsed - before;
  const rows = /** @type {Map<string, unknown>} */ (
    Reflect.get(buffer, 'rows')
  );
  assert.equal(rows.size, count);
  return growth;
}

/** @param {number[]} values @returns {number} */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const halfCapHeapBytes = median(
  Array.from({ length: 3 }, () =>
    measureDistinctKeys(PUBLIC_API_MAJOR_USAGE_MAX_KEYS / 2),
  ),
);
const fullCapHeapBytes = median(
  Array.from({ length: 3 }, () =>
    measureDistinctKeys(PUBLIC_API_MAJOR_USAGE_MAX_KEYS),
  ),
);
const estimatedUncappedBytesPerKey = Math.round(
  (fullCapHeapBytes - halfCapHeapBytes) / (PUBLIC_API_MAJOR_USAGE_MAX_KEYS / 2),
);

let droppedSamples = 0;
let databaseUnavailable = false;
/** @type {PublicApiMajorUsageWrite[]} */
const writes = [];
/** @type {PublicApiMajorUsageRepositoryPort & {writes: PublicApiMajorUsageWrite[]}} */
const repository = {
  /** @param {string} _environment @param {PublicApiMajorUsageWrite} write */
  async add(_environment, write) {
    if (databaseUnavailable) throw new Error('simulated database outage');
    writes.push(write);
  },
  /** @returns {Promise<never>} */
  async snapshot() {
    throw new Error('not used');
  },
};
const buffer = new PublicApiMajorUsageBuffer(() => {
  droppedSamples += 1;
});
const flusher = new PublicApiMajorUsageFlusher(
  buffer,
  repository,
  'production',
  {
    processId: '00000000-0000-4000-8000-000000000001',
    startedAt: new Date('2026-09-30T00:00:00Z'),
  },
  () => undefined,
  () => new Date('2026-10-31T00:00:00Z'),
);

collectGarbage();
const outageHeapBefore = process.memoryUsage().heapUsed;
for (
  let organization = 0;
  organization < PUBLIC_API_MAJOR_USAGE_MAX_KEYS;
  organization += 1
) {
  buffer.record({
    major: 1,
    organizationId: `pending_${organization}`,
    failed: false,
    callerKind: 'api-key',
    at: new Date(Date.parse('2026-09-30T00:00:00Z') + organization),
  });
}
databaseUnavailable = true;
await flusher.flush();

const workload = {
  outageDays: 30,
  organizationsPerDay: 4_096,
  requestsPerOrganizationPerDay: 10,
};
const start = Date.parse('2026-10-01T00:00:00Z');
const dayMs = 24 * 60 * 60 * 1000;
for (let day = 0; day < workload.outageDays; day += 1) {
  for (
    let organization = 0;
    organization < workload.organizationsPerDay;
    organization += 1
  ) {
    for (
      let request = 0;
      request < workload.requestsPerOrganizationPerDay;
      request += 1
    ) {
      const organizationId =
        (organization * workload.requestsPerOrganizationPerDay + request) %
          1_000 ===
        0
          ? undefined
          : `org_${organization}`;
      buffer.record({
        major: 1,
        ...(organizationId === undefined ? {} : { organizationId }),
        failed: false,
        callerKind: organizationId === undefined ? 'bearer' : 'api-key',
        at: new Date(
          start +
            day * dayMs +
            organization * workload.requestsPerOrganizationPerDay +
            request,
        ),
      });
    }
  }
}

collectGarbage();
const memory = process.memoryUsage();
const pending = /** @type {PublicApiMajorUsageWrite | undefined} */ (
  Reflect.get(flusher, 'unconfirmed')
);
assert.ok(pending);
const activeRows = /** @type {Map<string, unknown>} */ (
  Reflect.get(buffer, 'rows')
);
const activeUnattributed = /** @type {Map<string, unknown>} */ (
  Reflect.get(buffer, 'unattributed')
);
const activeKeys = activeRows.size + activeUnattributed.size;
const pendingKeys = pending.rows.length + pending.unattributed.length;
assert.equal(activeKeys, PUBLIC_API_MAJOR_USAGE_MAX_KEYS);
assert.equal(pendingKeys, PUBLIC_API_MAJOR_USAGE_MAX_KEYS);
assert.ok(memory.rss < maxMemoryBytes, 'RSS stayed below 768 MiB');

/** @param {string} name @returns {number | undefined} */
const result = {
  node: process.version,
  memoryLimitMiB: 768,
  keyCapPerBuffer: PUBLIC_API_MAJOR_USAGE_MAX_KEYS,
  measuredUncappedGrowth: {
    samplesAtHalfCap: PUBLIC_API_MAJOR_USAGE_MAX_KEYS / 2,
    samplesAtFullCap: PUBLIC_API_MAJOR_USAGE_MAX_KEYS,
    estimatedBytesPerKey: estimatedUncappedBytesPerKey,
    fullCapHeapMiB: Number((fullCapHeapBytes / MiB).toFixed(2)),
  },
  outage: {
    ...workload,
    requestAttempts:
      workload.outageDays *
      workload.organizationsPerDay *
      workload.requestsPerOrganizationPerDay,
    pendingKeys,
    activeKeys,
    retainedKeys: pendingKeys + activeKeys,
    droppedSamples,
    heapDeltaMiB: Number(
      ((memory.heapUsed - outageHeapBefore) / MiB).toFixed(2),
    ),
    rssMiB: Number((memory.rss / MiB).toFixed(2)),
  },
};

databaseUnavailable = false;
await flusher.flush();
assert.deepEqual(
  writes.map(({ batch }) => batch),
  [1, 2],
);
assert.deepEqual(
  writes.map(({ rows, unattributed }) => rows.length + unattributed.length),
  [PUBLIC_API_MAJOR_USAGE_MAX_KEYS, PUBLIC_API_MAJOR_USAGE_MAX_KEYS],
);
const recovery = {
  batches: writes.map(({ batch }) => batch),
  retainedKeysPerBatch: writes.map(
    ({ rows, unattributed }) => rows.length + unattributed.length,
  ),
};
process.stdout.write(`${JSON.stringify({ ...result, recovery }, null, 2)}\n`);
