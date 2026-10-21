import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { summarizeRepetitions } from './capacity-benchmark-utils.mjs';

const expectedRepetitions = Number(process.argv[2] ?? 3);
const artifactRoot = path.resolve(
  process.argv[3] ?? 'artifacts/capacity-benchmark',
);
const entries = await readdir(artifactRoot, { withFileTypes: true });
const reports = [];
for (const entry of entries.filter((item) => item.isDirectory())) {
  try {
    const resultPath = path.join(artifactRoot, entry.name, 'results.json');
    reports.push(JSON.parse(await readFile(resultPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const summary = summarizeRepetitions(reports, expectedRepetitions);
const jsonPath = path.join(artifactRoot, 'repetitions-summary.json');
const markdownPath = path.join(artifactRoot, 'repetitions-summary.md');
const markdown = renderMarkdown(summary);
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
  writeFile(markdownPath, markdown),
]);
process.stdout.write(markdown);

function renderMarkdown(result) {
  const host = result.host;
  const lines = [
    '# Capacity benchmark repetitions',
    '',
    `- Commit: \`${result.runtimeCommit}\``,
    `- Runner: ${result.runnerDescription ?? 'not recorded'}`,
    `- Host: ${host.operatingSystem}; ${host.logicalCpuCount} logical CPUs; ${host.cpuModel ?? 'CPU model unavailable'}; ${(host.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB RAM`,
    `- Stages: ${result.stageRatesRps.join(', ')} RPS`,
    `- Minimum grading samples per route: ${result.minimumGradingSamples}`,
    `- Repetitions: ${result.repetitionCount}`,
    '',
    '| Stage | Route | Completed samples by repetition | Errors by repetition | p99 min / median / max (ms) | Accepted p99 min / median / max (ms) | Sample verdict |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const spread = (value) =>
    value ? `${value.min} / ${value.median} / ${value.max}` : 'unavailable';
  for (const stage of result.stages) {
    for (const [routeName, route] of Object.entries(stage.routes)) {
      const counts = route.samples
        .map(({ repetition, count }) => `R${repetition}: ${count}`)
        .join(', ');
      const errors = route.samples
        .map(({ repetition, errorCount }) => `R${repetition}: ${errorCount}`)
        .join(', ');
      lines.push(
        `| ${stage.label} | ${routeName} | ${counts} | ${errors} | ${spread(route.p99Ms)} | ${spread(route.acceptedP99Ms)} | ${route.sampleVerdict} |`,
      );
    }
  }

  lines.push(
    '',
    'Each stage verdict is inconclusive if it is missing a repetition or any grading route has fewer than the configured minimum samples. The sample verdict counts every response, so read it with the error column: a route that answers only with errors has enough samples but no capacity. Accepted p99 covers 2xx responses only.',
    '',
  );
  return lines.join('\n');
}
