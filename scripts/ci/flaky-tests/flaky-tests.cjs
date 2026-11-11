/**
 * @typedef {"passed" | "failed" | "skipped"} CaseStatus
 * @typedef {{id: string, file: string, name: string, className: string, line: string, durationMs: number, status: CaseStatus}} JUnitCase
 * @typedef {{cases: JUnitCase[], failedFiles: string[]}} JUnitReport
 * @typedef {{exitCode: number, failedFiles: string[], cases?: JUnitCase[], reportError?: string}} RetryResult
 * @typedef {RetryResult & {cases: JUnitCase[], attempt?: number}} TestAttempt
 * @typedef {{file: string, name: string, reason: string, className?: string}} Exemption
 * @typedef {{at: string, tests: number, flakes: number, attempts: number}} HistoryRun
 * @typedef {{file: string, name: string, className: string, line: string, runs: number, flakyRuns: number, durationsMs: number[], lastSeenAt: string, exempt: boolean}} HistoryTest
 * @typedef {{schemaVersion: 1, runs: HistoryRun[], tests: Record<string, HistoryTest>}} FlakyHistory
 * @typedef {{id: string, file: string, name: string, className: string, line: string, runs: number, flakyRuns: number, averageDurationMs: number, exempt: boolean, reason?: string}} ReportTest
 * @typedef {{schemaVersion: 1, generatedAt: string, status: "passed" | "failed", attempts: number, retryCount: number, observedTestCount: number, testCount: number, exemptedTestCount: number, flakyCount: number, exemptFlakyCount: number, currentFlakeRate: number, recentRunCount: number, recentTestCount: number, recentFlakeCount: number, recentFlakeRate: number, threshold: number, alert: boolean, flakyTests: ReportTest[], failedTests: ReportTest[], slowestTests: ReportTest[]}} FlakyReport
 * @typedef {{generatedAt?: string, threshold?: number, exemptions?: Exemption[], history?: FlakyHistory}} ReportOptions
 * @typedef {{report: FlakyReport, history: FlakyHistory}} FlakyReportResult
 */

const HISTORY_WINDOW_RUNS = 30;
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DURATION_SAMPLES = 30;
/** @type {Record<string, string>} */
const XML_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** @param {string} entity @param {string} code */
function decodeXmlEntity(entity, code) {
  if (code[0] !== '#') {
    return XML_ENTITIES[code.toLowerCase()] ?? entity;
  }

  const point =
    code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
  return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
    ? String.fromCodePoint(point)
    : entity;
}

/** @param {string} value */
function decodeXml(value) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|lt|gt|quot|apos|amp);/gi,
    decodeXmlEntity,
  );
}

/** @param {string} source */
function attributes(source) {
  return /** @type {Record<string, string>} */ (
    Object.fromEntries(
      [...source.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((match) => [
        match[1],
        decodeXml(match[2] ?? ''),
      ]),
    )
  );
}

/** @param {string | undefined} value */
function normalizeFile(value) {
  const file = value?.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file || file.startsWith('/') || file.split('/').includes('..')) {
    return null;
  }
  return file;
}

/** @param {string} xml @returns {JUnitReport} */
function parseJUnitReport(xml) {
  /** @type {JUnitCase[]} */
  const cases = [];
  /** @type {Set<string>} */
  const failedFiles = new Set();
  /** @type {Map<string, number>} */
  const occurrences = new Map();

  for (const match of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const fields = attributes(match[1] ?? '');
    const file = normalizeFile(fields.file);
    if (!file) continue;

    const name = fields.name ?? 'unnamed test';
    const className = fields.classname ?? '';
    const line = fields.line ?? '';
    const baseId = [file, className, line, name].join('\u001f');
    const occurrence = occurrences.get(baseId) ?? 0;
    occurrences.set(baseId, occurrence + 1);
    const id = `${baseId}\u001f${occurrence}`;
    const body = match[2] ?? '';
    const status = /<(?:failure|error)\b/.test(body)
      ? 'failed'
      : /<skipped\b/.test(body)
        ? 'skipped'
        : 'passed';
    const duration = Number(fields.time);

    cases.push({
      id,
      file,
      name,
      className,
      line,
      durationMs:
        Number.isFinite(duration) && duration >= 0
          ? Math.round(duration * 1000)
          : 0,
      status,
    });
    if (status === 'failed') failedFiles.add(file);
  }

  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const fields = attributes(match[1] ?? '');
    const file = normalizeFile(fields.file);
    const failures = Number(fields.failures ?? 0) + Number(fields.errors ?? 0);
    if (file && failures > 0) failedFiles.add(file);
  }

  return { cases, failedFiles: [...failedFiles].sort() };
}

/**
 * @param {(input: {attempt: number, files: string[] | null}) => RetryResult} run
 * @param {number} retryCount
 * @returns {TestAttempt[]}
 */
function runWithRetries(run, retryCount) {
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 5) {
    throw new RangeError('retryCount must be an integer from 0 to 5');
  }

  /** @type {TestAttempt[]} */
  const attempts = [];
  let files = null;
  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    const result = run({ attempt, files });
    const normalized = {
      ...result,
      cases: result.cases ?? [],
      failedFiles: result.failedFiles ?? [],
      attempt,
    };
    attempts.push(normalized);
    if (normalized.exitCode === 0 || normalized.failedFiles.length === 0) break;
    files = [...new Set(normalized.failedFiles)].sort();
  }
  return attempts;
}

/** @param {JUnitCase} testCase @param {Exemption[]} exemptions */
function exemptionFor(testCase, exemptions) {
  return exemptions.find(
    (exemption) =>
      exemption.file === testCase.file &&
      exemption.name === testCase.name &&
      (!exemption.className || exemption.className === testCase.className),
  );
}

/** @returns {FlakyHistory} */
function emptyHistory() {
  return { schemaVersion: 1, runs: [], tests: {} };
}

/** @param {number[]} values */
function average(values) {
  return values.length
    ? Math.round(
        values.reduce((total, value) => total + value, 0) / values.length,
      )
    : 0;
}

/** @param {number} part @param {number} whole */
function fraction(part, whole) {
  return whole > 0 ? part / whole : 0;
}

/**
 * @param {TestAttempt[]} attempts
 * @param {ReportOptions} [options]
 * @returns {FlakyReportResult}
 */
function createFlakyReport(attempts, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const threshold = options.threshold ?? 0.05;
  const exemptions = options.exemptions ?? [];
  const oldHistory = options.history ?? emptyHistory();
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be between 0 and 1');
  }

  /** @type {Map<string, {testCase: JUnitCase, statuses: Set<CaseStatus>, durationsMs: number[]}>} */
  const resultsById = new Map();
  for (const attempt of attempts) {
    for (const testCase of attempt.cases) {
      const result = resultsById.get(testCase.id) ?? {
        testCase,
        statuses: new Set(),
        durationsMs: [],
      };
      result.testCase = testCase;
      result.statuses.add(testCase.status);
      result.durationsMs.push(testCase.durationMs);
      resultsById.set(testCase.id, result);
    }
  }

  const baseline =
    attempts[0]?.cases.filter((testCase) => testCase.status !== 'skipped') ??
    [];
  const flakyIds = new Set(
    baseline
      .filter((testCase) => {
        const statuses = resultsById.get(testCase.id)?.statuses;
        return statuses?.has('failed') && statuses.has('passed');
      })
      .map((testCase) => testCase.id),
  );
  const tests = { ...oldHistory.tests };
  const cutoff = Date.parse(generatedAt) - HISTORY_MAX_AGE_MS;

  for (const [id, testStats] of Object.entries(tests)) {
    if (
      !Number.isFinite(Date.parse(testStats.lastSeenAt)) ||
      Date.parse(testStats.lastSeenAt) < cutoff
    ) {
      delete tests[id];
    }
  }

  /** @type {ReportTest[]} */
  const currentFlakyTests = [];
  /** @type {ReportTest[]} */
  const failedTests = [];
  /** @type {ReportTest[]} */
  const slowestTests = [];
  let testCount = 0;
  let exemptedTestCount = 0;

  for (const testCase of baseline) {
    const exemption = exemptionFor(testCase, exemptions);
    const result = resultsById.get(testCase.id);
    const isFlaky = flakyIds.has(testCase.id);
    const durationSamples = result?.durationsMs ?? [testCase.durationMs];
    const previous = tests[testCase.id] ?? {
      runs: 0,
      flakyRuns: 0,
      durationsMs: [],
    };
    const updated = {
      file: testCase.file,
      name: testCase.name,
      className: testCase.className,
      line: testCase.line,
      runs: previous.runs + 1,
      flakyRuns: previous.flakyRuns + Number(isFlaky),
      durationsMs: [...previous.durationsMs, ...durationSamples].slice(
        -MAX_DURATION_SAMPLES,
      ),
      lastSeenAt: generatedAt,
      exempt: Boolean(exemption),
    };
    tests[testCase.id] = updated;

    // Exemptions silence rate alerts only; they never skip or forgive a failure.
    if (exemption) exemptedTestCount += 1;
    else testCount += 1;

    const item = {
      id: testCase.id,
      file: testCase.file,
      name: testCase.name,
      className: testCase.className,
      line: testCase.line,
      runs: updated.runs,
      flakyRuns: updated.flakyRuns,
      averageDurationMs: average(updated.durationsMs),
      exempt: Boolean(exemption),
      ...(exemption ? { reason: exemption.reason } : {}),
    };

    if (isFlaky) currentFlakyTests.push(item);
    if (result?.testCase.status === 'failed') failedTests.push(item);
    slowestTests.push(item);
  }

  const eligibleFlakes = currentFlakyTests.filter(
    (testCase) => !testCase.exempt,
  );
  const currentFlakeRate = fraction(eligibleFlakes.length, testCount);
  const previousRuns = oldHistory.runs.filter(
    (run) =>
      Number.isFinite(Date.parse(run.at)) &&
      Date.parse(run.at) >= cutoff &&
      Number.isFinite(run.tests) &&
      Number.isFinite(run.flakes),
  );
  const runs = [
    ...previousRuns,
    {
      at: generatedAt,
      tests: testCount,
      flakes: eligibleFlakes.length,
      attempts: attempts.length,
    },
  ].slice(-HISTORY_WINDOW_RUNS);
  const recentTestCount = runs.reduce((total, run) => total + run.tests, 0);
  const recentFlakeCount = runs.reduce((total, run) => total + run.flakes, 0);
  const recentFlakeRate = fraction(recentFlakeCount, recentTestCount);
  const finalAttempt = attempts.at(-1);

  slowestTests.sort((a, b) => b.averageDurationMs - a.averageDurationMs);
  currentFlakyTests.sort((a, b) => b.flakyRuns - a.flakyRuns);

  return {
    report: {
      schemaVersion: 1,
      generatedAt,
      status: finalAttempt?.exitCode === 0 ? 'passed' : 'failed',
      attempts: attempts.length,
      retryCount: Math.max(0, attempts.length - 1),
      observedTestCount: baseline.length,
      testCount,
      exemptedTestCount,
      flakyCount: eligibleFlakes.length,
      exemptFlakyCount: currentFlakyTests.length - eligibleFlakes.length,
      currentFlakeRate,
      recentRunCount: runs.length,
      recentTestCount,
      recentFlakeCount,
      recentFlakeRate,
      threshold,
      alert: recentFlakeRate > threshold,
      flakyTests: currentFlakyTests,
      failedTests,
      slowestTests: slowestTests.slice(0, 5),
    },
    history: { schemaVersion: 1, runs, tests },
  };
}

/** @param {unknown} value */
function safeText(value) {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  return text
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('@', '@\u200b')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', 'ˋ')
    .replaceAll('|', '\\|')
    .slice(0, 180);
}

/** @param {number} value */
function percent(value) {
  return `${(Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(2)}%`;
}

/** @param {number} value */
function milliseconds(value) {
  return `${Math.max(0, Math.round(Number(value) || 0))} ms`;
}

/** @param {FlakyReport} report */
function formatFlakyComment(report) {
  const lines = [
    '<!-- aihub-flaky-tests -->',
    '### CI flaky test report',
    '',
    `- Result: **${report.status === 'passed' ? 'passed' : 'failed after retries'}** (${report.attempts} attempt${report.attempts === 1 ? '' : 's'})`,
    `- Tests tracked: ${report.testCount} of ${report.observedTestCount}; exempted: ${report.exemptedTestCount}`,
    `- Flaky tests this run: ${report.flakyCount} (${percent(report.currentFlakeRate)})`,
    `- Recent rate: ${percent(report.recentFlakeRate)} across ${report.recentRunCount} runs; alert threshold: ${percent(report.threshold)}`,
  ];

  if (report.alert)
    lines.push('', '⚠️ Flakiness is above the configured threshold.');
  if (report.flakyTests.length > 0) {
    lines.push(
      '',
      '| Test | Flaky runs | Average duration |',
      '| --- | ---: | ---: |',
    );
    for (const testCase of report.flakyTests.slice(0, 10)) {
      const frequency = `${testCase.flakyRuns}/${testCase.runs}`;
      lines.push(
        `| \`${safeText(testCase.file)}\` · \`${safeText(testCase.name)}\` | ${frequency} | ${milliseconds(testCase.averageDurationMs)} |`,
      );
    }
  } else {
    lines.push('', 'No flaky tests were observed in this run.');
  }

  if (report.failedTests.length > 0) {
    lines.push('', 'Tests still failing after retries:');
    for (const testCase of report.failedTests.slice(0, 10)) {
      lines.push(
        `- \`${safeText(testCase.file)}\` · \`${safeText(testCase.name)}\``,
      );
    }
  }

  if (report.slowestTests.length > 0) {
    lines.push('', 'Slowest tests by recent average duration:');
    for (const testCase of report.slowestTests) {
      lines.push(
        `- \`${safeText(testCase.file)}\` · \`${safeText(testCase.name)}\`: ${milliseconds(testCase.averageDurationMs)}`,
      );
    }
  }

  return lines.join('\n');
}

module.exports = {
  createFlakyReport,
  formatFlakyComment,
  parseJUnitReport,
  runWithRetries,
};
