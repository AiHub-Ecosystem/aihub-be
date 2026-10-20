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
    '| Stage | Route | Completed samples by repetition | p99 min / median / max (ms) | Verdict |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const stage of result.stages) {
    for (const [routeName, route] of Object.entries(stage.routes)) {
      const counts = route.samples
        .map(({ repetition, count }) => `R${repetition}: ${count}`)
        .join(', ');
      const spread = route.p99Ms
        ? `${route.p99Ms.min} / ${route.p99Ms.median} / ${route.p99Ms.max}`
        : 'unavailable';
      lines.push(
        `| ${stage.label} | ${routeName} | ${counts} | ${spread} | ${route.sampleVerdict} |`,
      );
    }
  }

  lines.push(
    '',
    'Each stage verdict is inconclusive if it is missing a repetition or any grading route has fewer than the configured minimum samples.',
    '',
  );
  return lines.join('\n');
}
