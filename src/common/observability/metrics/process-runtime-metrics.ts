import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Counter, Gauge, type Registry } from '@prometheus-io/client';

export function registerProcessRuntimeMetrics(registry: Registry): void {
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  let previousCpuUsage = process.cpuUsage();
  new Counter({
    name: 'aihub_process_cpu_seconds_total',
    help: 'Total CPU time consumed by this Node.js process, in seconds.',
    registers: [registry],
    collect() {
      const currentCpuUsage = process.cpuUsage();
      this.inc(
        (currentCpuUsage.user -
          previousCpuUsage.user +
          currentCpuUsage.system -
          previousCpuUsage.system) /
          1_000_000,
      );
      previousCpuUsage = currentCpuUsage;
    },
  });

  new Gauge({
    name: 'aihub_process_resident_memory_bytes',
    help: 'Resident memory used by this Node.js process, in bytes.',
    registers: [registry],
    collect() {
      this.set(process.memoryUsage().rss);
    },
  });

  new Gauge({
    name: 'aihub_process_heap_used_bytes',
    help: 'V8 heap currently used by this Node.js process, in bytes.',
    registers: [registry],
    collect() {
      this.set(process.memoryUsage().heapUsed);
    },
  });

  new Gauge({
    name: 'aihub_event_loop_lag_seconds',
    help: '99th percentile event-loop delay since the previous metrics scrape, in seconds.',
    registers: [registry],
    collect() {
      const lagSeconds = eventLoopDelay.percentile(99) / 1_000_000_000;
      this.set(Number.isFinite(lagSeconds) ? lagSeconds : 0);
      eventLoopDelay.reset();
    },
  });
}
