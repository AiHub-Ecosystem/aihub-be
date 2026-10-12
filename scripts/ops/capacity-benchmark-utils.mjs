export function highestPassingRate(runs, routeNames, deadlineMs) {
  return runs
    .filter(
      (run) =>
        hasCompleteLoadDelivery(run) &&
        routeNames.every((name) => {
          const route = run.routes[name];
          return (
            route !== undefined &&
            route.count > 0 &&
            route.p99Ms !== null &&
            route.p99Ms <=
              (typeof deadlineMs === 'number'
                ? deadlineMs
                : deadlineMs[name]) &&
            route.errorCount === 0
          );
        }),
    )
    .reduce((highest, run) => Math.max(highest, run.offeredRateRps), 0);
}

export function hasCompleteLoadDelivery(run) {
  const duration = /^(\d+)s$/.exec(run.holdDuration);
  const durationSeconds = Number(duration?.[1]);
  const expectedRequests = run.offeredRateRps * durationSeconds;
  return (
    Number.isSafeInteger(durationSeconds) &&
    durationSeconds > 0 &&
    Number.isSafeInteger(run.offeredRateRps) &&
    run.offeredRateRps > 0 &&
    Number.isSafeInteger(expectedRequests) &&
    Number.isSafeInteger(run.completedRequests) &&
    run.droppedIterations === 0 &&
    run.completedRequests >= expectedRequests
  );
}

export function overloadRate(stageRates, passingRate) {
  if (passingRate <= 0) {
    const highestStage = stageRates.at(-1);
    if (highestStage === undefined)
      throw new Error('no rate stages configured');
    return Math.ceil(highestStage * 1.5);
  }
  const nextStage = stageRates.find((rate) => rate > passingRate);
  if (nextStage !== undefined) return nextStage;
  const highestStage = stageRates.at(-1);
  if (highestStage === undefined) throw new Error('no rate stages configured');
  return Math.ceil(Math.max(highestStage, passingRate) * 1.5);
}

export function metricValue(metrics, name, statistic = 'max') {
  const values = metrics[name]?.values;
  const value = values?.[statistic];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function jsonAfterPrefix(text, prefix) {
  const line = text.split(/\r?\n/).find((item) => item.includes(prefix));
  if (line === undefined) return undefined;
  const payload = line.slice(line.indexOf(prefix) + prefix.length).trim();
  const end = payload.lastIndexOf('}');
  if (end < 0) return undefined;
  const serialized = payload.slice(0, end + 1);
  return JSON.parse(
    serialized.startsWith('{\\"')
      ? serialized.replace(/\\"/g, '"')
      : serialized,
  );
}

export function taggedMetricValues(metrics, prefix) {
  return Object.entries(metrics)
    .filter(([name]) => name.startsWith(`${prefix}{`) && name.endsWith('}'))
    .map(([name, metric]) => ({
      labels: Object.fromEntries(
        [
          ...name.slice(prefix.length + 1, -1).matchAll(/([^,:]+):([^,]*)/g),
        ].map((match) => [match[1], match[2]]),
      ),
      values: metric.values ?? {},
    }));
}

export function parseDockerStats(line) {
  const stats = JSON.parse(line);
  return {
    cpuPercent: parseFloat(stats.CPUPerc),
    memoryBytes: parseBytes(stats.MemUsage?.split('/')[0]?.trim() ?? ''),
  };
}

function parseBytes(value) {
  const match = value.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)$/i);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
  }[unit];
  return multiplier === undefined ? null : Math.round(amount * multiplier);
}
