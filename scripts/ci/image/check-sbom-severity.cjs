/// <reference types="node" />

const { existsSync, readFileSync } = require('node:fs');

const DEFAULT_SEVERITY_CUTOFF = 'high';

/** @type {Record<string, number>} */
const SEVERITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** @param {string | undefined} severity @returns {number} */
function severityRank(severity) {
  if (!severity) return -1;
  const rank = SEVERITY_RANK[severity.toLowerCase()];
  return typeof rank === 'number' ? rank : -1;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} report
 * @param {string} [cutoff]
 * @returns {{ total: number, bySeverity: Record<string, number> }}
 */
function countFindingsAtOrAbove(report, cutoff = DEFAULT_SEVERITY_CUTOFF) {
  const matches =
    isRecord(report) && Array.isArray(report['matches'])
      ? report['matches']
      : [];
  const threshold = severityRank(cutoff);
  if (threshold < 0) throw new Error(`unknown severity cutoff: ${cutoff}`);

  /** @type {string[]} */
  const findings = [];
  for (const match of matches) {
    if (!isRecord(match)) continue;
    const vuln = match['vulnerability'];
    if (!isRecord(vuln)) continue;
    const severity =
      typeof vuln['severity'] === 'string' ? vuln['severity'] : undefined;
    if (severity && severityRank(severity) >= threshold) {
      findings.push(severity.toLowerCase());
    }
  }

  /** @type {Record<string, number>} */
  const bySeverity = {};
  for (const s of findings) {
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
  }

  return {
    total: findings.length,
    bySeverity,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ file: string, threshold: string }}
 */
function parseArgs(argv) {
  const [file, ...rest] = argv;
  if (!file)
    throw new Error(
      'usage: check-sbom-severity.cjs <grype-json> [--threshold high]',
    );
  let threshold = DEFAULT_SEVERITY_CUTOFF;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--threshold' && rest[i + 1]) {
      threshold = String(rest[++i]);
    } else {
      throw new Error(`unknown argument: ${rest[i]}`);
    }
  }
  if (severityRank(threshold) < 0)
    throw new Error(`unknown severity cutoff: ${threshold}`);
  return { file, threshold };
}

/**
 * @param {string[]} [argv]
 * @returns {void}
 */
function main(argv = process.argv.slice(2)) {
  const { file, threshold } = parseArgs(argv);
  if (!existsSync(file)) throw new Error(`grype report not found: ${file}`);
  const report = /** @type {unknown} */ (
    JSON.parse(readFileSync(file, 'utf8'))
  );
  const result = countFindingsAtOrAbove(report, threshold);
  process.stdout.write(
    `SBOM scan: ${result.total} finding(s) at or above ${threshold} ${JSON.stringify(result.bySeverity)}\n`,
  );
  if (result.total > 0) {
    process.stderr.write(
      `SBOM gate: failing release, ${result.total} vulnerability finding(s) at or above ${threshold}\n`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SEVERITY_CUTOFF,
  countFindingsAtOrAbove,
  parseArgs,
  severityRank,
};
