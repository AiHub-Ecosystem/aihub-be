/**
 * One coverage figure across every lane that runs against `src`.
 *
 * Each lane instruments `src` on its own: the unit lane without a database,
 * the database lane and the tenant-isolation lane with one. Reading any single
 * lane's number answers a different question than the next lane does, which is
 * how a repository can report 0% branch coverage on a file the very next lane
 * tests end to end (#320).
 *
 * With `--check` it also fails a pull request whose merged coverage drops more
 * than the agreed margin against the committed baseline. A delta gate rather
 * than a floor: a floor rewards tests written only to raise a number, and
 * punishes a repository that starts honest.
 */
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const coverageLibrary = require('istanbul-lib-coverage');

/**
 * The agreed margin, in percentage points, and why it is that number.
 *
 * Half a point is above the drift one added or removed source file produces on
 * a codebase this size, and well below what losing a suite's worth of coverage
 * would take. A wider margin would fail pull requests for noise; a narrower one
 * would let a real regression through between reviews. It is recorded in
 * `test/coverage-baseline.json` so the gate and its reason travel together, and
 * raising it is a deliberate commit rather than a number someone edits.
 */
const DEFAULT_MARGIN_POINTS = 0.5;

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

const BASELINE_PATH = 'test/coverage-baseline.json';

/**
 * Production code only. The unit lane collects every file under `src`, which
 * includes spec files and the in-memory adapters under `testing/`, while the
 * database lane collects only what its suites touch. Merging the two as they
 * stand would compare two different definitions of the denominator, so both are
 * narrowed to production code before anything is added up (#320).
 */
function isProductionCode(relativePath) {
  return (
    !relativePath.endsWith('.spec.ts') &&
    !relativePath.includes('/testing/') &&
    !relativePath.endsWith('/testing')
  );
}

function productionOnly(map, root) {
  const entries = {};
  for (const filePath of map.files()) {
    const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
    if (isProductionCode(relativePath)) {
      entries[filePath] = map.fileCoverageFor(filePath).toJSON();
    }
  }
  return coverageLibrary.createCoverageMap(entries);
}

function branchPercent(summary) {
  return summary.branches.total === 0
    ? null
    : (100 * summary.branches.covered) / summary.branches.total;
}

/**
 * A drop is a failure only when it exceeds the margin, and only for a metric
 * the baseline actually recorded. A metric the baseline never carried is
 * reported rather than assumed to have held.
 *
 * A missing baseline fails outright: certifying coverage against nothing is the
 * one outcome that must never read as a pass.
 */
function compareCoverage(
  baseline,
  current,
  marginPoints = DEFAULT_MARGIN_POINTS,
) {
  const hasBaseline = baseline !== undefined && baseline !== null;
  const findings = [];
  for (const metric of ['lines', 'branches', 'statements', 'functions']) {
    const before = hasBaseline ? baseline[metric] : undefined;
    const after = current === undefined ? undefined : current[metric];
    if (before === undefined || after === undefined) {
      findings.push({
        metric,
        status: 'unknown',
        baseline: before,
        current: after,
        delta: undefined,
      });
      continue;
    }
    findings.push({
      metric,
      status: before - after > marginPoints ? 'drop' : 'ok',
      baseline: before,
      current: after,
      delta: after - before,
    });
  }
  return {
    ok: hasBaseline && findings.every((finding) => finding.status !== 'drop'),
    marginPoints,
    findings,
  };
}

function loadLane(root, lane) {
  const reportPath = path.join(root, lane.report);
  if (!existsSync(reportPath)) {
    return { ...lane, missing: true };
  }
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (Object.keys(parsed).length === 0) {
    return { ...lane, missing: true };
  }
  return {
    ...lane,
    missing: false,
    map: coverageLibrary.createCoverageMap(parsed),
  };
}

function formatPercent(value) {
  return value === null ? ' n/a' : `${value.toFixed(1)}%`;
}

function branchGaps(root, map, limit) {
  return map
    .files()
    .map((filePath) => {
      const summary = map.fileCoverageFor(filePath).toSummary();
      const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
      return {
        file: relativePath,
        branchTotal: summary.branches.total,
        branchCovered: summary.branches.covered,
        branchPercent: branchPercent(summary),
        linePercent:
          summary.lines.total === 0
            ? null
            : (100 * summary.lines.covered) / summary.lines.total,
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

function readBaseline(root) {
  const baselinePath = path.join(root, BASELINE_PATH);
  return existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : undefined;
}

function mergedPercentages(totals) {
  return {
    lines: (100 * totals.lines.covered) / totals.lines.total,
    branches: (100 * totals.branches.covered) / totals.branches.total,
    statements: (100 * totals.statements.covered) / totals.statements.total,
    functions: (100 * totals.functions.covered) / totals.functions.total,
  };
}

function main(argv = process.argv.slice(2), root = process.cwd()) {
  const shouldCheck = argv.includes('--check');
  const shouldWriteBaseline = argv.includes('--write-baseline');
  const marginArgument = argv.find((argument) =>
    argument.startsWith('--margin='),
  );
  const marginPoints =
    marginArgument === undefined
      ? DEFAULT_MARGIN_POINTS
      : Number(marginArgument.split('=')[1]);

  const lanes = LANES.map((lane) => loadLane(root, lane));
  const present = lanes.filter((lane) => !lane.missing);
  const absent = lanes.filter((lane) => lane.missing);

  if (present.length === 0) {
    console.error(
      'No lane coverage report found. Produce them with pnpm coverage:unit, pnpm coverage:db and pnpm coverage:tenant-isolation.',
    );
    return 1;
  }

  const merged = productionOnly(present[0].map, root);
  for (const lane of present.slice(1)) {
    merged.merge(productionOnly(lane.map, root));
  }

  const totals = merged.getCoverageSummary().toJSON();
  const report = mergedPercentages(totals);

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
      `  ${metric.padEnd(12)} ${formatPercent((100 * entry.covered) / entry.total)} (${entry.covered}/${entry.total})`,
    );
  }

  const gaps = branchGaps(root, merged, 20);
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

  const outputDirectory = path.join(root, 'coverage/merged');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    path.join(outputDirectory, 'coverage-summary.json'),
    `${JSON.stringify(totals, null, 2)}\n`,
    'utf8',
  );
  console.log('\nWrote coverage/merged/coverage-summary.json');

  if (shouldWriteBaseline) {
    writeFileSync(
      path.join(root, BASELINE_PATH),
      `${JSON.stringify(
        {
          ...report,
          marginPoints,
          recordedLanes: present.map((lane) => lane.name),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`Wrote ${BASELINE_PATH}`);
    return 0;
  }

  if (shouldCheck) {
    const baseline = readBaseline(root);
    if (baseline === undefined) {
      console.error(
        `No baseline at ${BASELINE_PATH}. Run pnpm coverage:merged -- --write-baseline and commit it.`,
      );
      return 1;
    }
    const comparison = compareCoverage(baseline, report, marginPoints);
    console.log(
      `\nDelta gate: margin ${comparison.marginPoints} points against ${BASELINE_PATH}`,
    );
    for (const finding of comparison.findings) {
      const delta =
        finding.delta === undefined
          ? 'n/a'
          : `${finding.delta >= 0 ? '+' : ''}${finding.delta.toFixed(2)}`;
      console.log(
        `  ${finding.metric.padEnd(11)} ${formatPercent(finding.baseline)} -> ${formatPercent(finding.current)}  ${delta}  ${finding.status}`,
      );
    }
    if (!comparison.ok) {
      console.error(
        '\nMerged coverage dropped further than the agreed margin. Restore the tests, or record why the drop is acceptable and raise the baseline deliberately.',
      );
      return 1;
    }
    console.log('Within the agreed margin.');
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  BASELINE_PATH,
  DEFAULT_MARGIN_POINTS,
  branchPercent,
  compareCoverage,
  isProductionCode,
  main,
};
