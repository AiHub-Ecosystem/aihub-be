/**
 * One coverage figure across every lane that runs against `src`.
 *
 * Each lane instruments `src` on its own: the unit lane without a database,
 * the database lane and the tenant-isolation lane with one. Reading any single
 * lane's number answers a different question than the next lane does, which is
 * how a repository can report 0% branch coverage on a file the very next lane
 * tests end to end (#320).
 *
 * This merges whatever lane reports exist and says which lanes it did not have,
 * so "is this rule tested?" is answerable from the tooling rather than inferred.
 *
 * Reports only. It never fails a build on a percentage: there is no agreed
 * baseline to compare against yet, and a gate that fails on its first day is a
 * gate people learn to ignore.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

import coverageLibrary from 'istanbul-lib-coverage';

const { createCoverageMap } = coverageLibrary;

const root = process.cwd();

/** High-consequence paths first: a gap there costs more than one elsewhere. */
const HIGH_CONSEQUENCE =
  /^src[\\/](?:modules[\\/](?:auth|identity|metering|gateway)[\\/]|common[\\/](?:errors|http)[\\/]|downstream[\\/])/;

const LANES = [
  { name: 'unit', report: 'coverage/unit/coverage-final.json' },
  { name: 'db', report: 'coverage/db/coverage-final.json' },
  {
    name: 'tenant-isolation',
    report: 'coverage/tenant-isolation/coverage-final.json',
  },
];

function loadLane(lane) {
  const path = join(root, lane.report);
  if (!existsSync(path)) {
    return { ...lane, missing: true };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const files = Object.keys(parsed);
  if (files.length === 0) {
    return { ...lane, missing: true };
  }
  return { ...lane, missing: false, map: createCoverageMap(parsed) };
}

function percent(covered, total) {
  return total === 0 ? null : (100 * covered) / total;
}

function formatPercent(value) {
  return value === null ? ' n/a' : `${value.toFixed(1)}%`;
}

function branchGaps(map, limit) {
  return map
    .files()
    .map((path) => {
      const summary = map.fileCoverageFor(path).toSummary();
      const relativePath = relative(root, path).replaceAll('\\', '/');
      return {
        file: relativePath,
        branchTotal: summary.branches.total,
        branchCovered: summary.branches.covered,
        branchPercent: percent(
          summary.branches.covered,
          summary.branches.total,
        ),
        linePercent: percent(summary.lines.covered, summary.lines.total),
        highConsequence: HIGH_CONSEQUENCE.test(relativePath),
      };
    })
    .filter((row) => row.branchTotal > 0)
    .filter((row) => row.branchCovered < row.branchTotal)
    .sort(
      (left, right) =>
        Number(right.highConsequence) - Number(left.highConsequence) ||
        right.branchTotal -
          right.branchCovered -
          (left.branchTotal - left.branchCovered) ||
        right.branchTotal - left.branchTotal,
    )
    .slice(0, limit);
}

const lanes = LANES.map(loadLane);
const present = lanes.filter((lane) => !lane.missing);
const absent = lanes.filter((lane) => lane.missing);

if (present.length === 0) {
  console.error(
    'No lane coverage report found. Produce them with pnpm coverage:unit, pnpm coverage:db and pnpm coverage:tenant-isolation.',
  );
  process.exit(1);
}

const merged = present[0].map;
for (const lane of present.slice(1)) {
  merged.merge(lane.map);
}

const totals = merged.getCoverageSummary().toJSON();

console.log(
  `\nMerged coverage from ${present.length} of ${LANES.length} lanes`,
);
for (const lane of present) {
  console.log(`  included: ${lane.name}`);
}
for (const lane of absent) {
  console.log(
    `  MISSING:  ${lane.name} (${lane.report}) - its files count as untested, not as unreachable`,
  );
}

console.log('\n  metric        merged');
for (const metric of ['statements', 'branches', 'functions', 'lines']) {
  const entry = totals[metric];
  console.log(
    `  ${metric.padEnd(12)} ${formatPercent(percent(entry.covered, entry.total))} (${entry.covered}/${entry.total})`,
  );
}

const gaps = branchGaps(merged, 20);
console.log(
  `\nFiles with unexercised branches (${gaps.length} shown, high-consequence first)`,
);
console.log('  branch%   line%   missing  file');
for (const gap of gaps) {
  console.log(
    `  ${formatPercent(gap.branchPercent).padStart(7)}  ${formatPercent(gap.linePercent).padStart(6)}  ${String(
      gap.branchTotal - gap.branchCovered,
    ).padStart(7)}  ${gap.file}`,
  );
}

const outputDirectory = join(root, 'coverage/merged');
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  join(outputDirectory, 'coverage-summary.json'),
  `${JSON.stringify(totals, null, 2)}\n`,
  'utf8',
);
console.log(`\nWrote coverage/merged/coverage-summary.json`);

if (absent.length > 0) {
  process.exitCode = 0;
}
