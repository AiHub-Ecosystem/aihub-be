import {
  type DownstreamConcurrencySample,
  recordDownstreamLimitDropped,
  setDownstreamConcurrencySource,
} from '@/common/observability/downstream-concurrency-metrics';

export interface Gradient2Config {
  readonly initialLimit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly queueSize: number;
  readonly smoothing: number;
  readonly rttTolerance: number;
  readonly longWindow: number;
}

const INITIAL_LIMIT = 10;
const MIN_LIMIT = 2;
const MAX_LIMIT = 20;
// Netflix ships tolerance 1.5 / longWindow 600 as defaults; this launcher
// uses the tighter tolerance and a faster window so the documented 20x spike
// converges to the floor. See ADR-0154.
const RTT_TOLERANCE = 1.25;
const LONG_WINDOW = 600;
const WARMUP = 10;
const QUEUE_SIZE = 1;
const SMOOTHING = 0.2;

export const GRADIENT2_DEFAULT_CONFIG: Gradient2Config = Object.freeze({
  initialLimit: INITIAL_LIMIT,
  minLimit: MIN_LIMIT,
  maxLimit: MAX_LIMIT,
  queueSize: QUEUE_SIZE,
  smoothing: SMOOTHING,
  rttTolerance: RTT_TOLERANCE,
  longWindow: LONG_WINDOW,
});

export class Gradient2Limit {
  private estimatedLimit: number;
  private longRtt = 0;
  private warmupSum = 0;
  private warmupCount = 0;
  private lastRtt = 0;
  private readonly factor: number;

  constructor(
    private readonly config: Gradient2Config = GRADIENT2_DEFAULT_CONFIG,
  ) {
    this.estimatedLimit = config.initialLimit;
    this.factor = 2 / (config.longWindow + 1);
  }

  onSample(rttMs: number, inFlight: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.lastRtt = rttMs;
    if (this.warmupCount < WARMUP) {
      this.warmupCount += 1;
      this.warmupSum += rttMs;
      this.longRtt = this.warmupSum / this.warmupCount;
    } else {
      this.longRtt = this.longRtt * (1 - this.factor) + rttMs * this.factor;
    }

    if (inFlight < this.estimatedLimit / 2) return;

    if (this.longRtt / rttMs > 2) {
      this.longRtt *= 0.95;
    }

    const gradient = Math.max(
      0.5,
      Math.min(1.0, (this.config.rttTolerance * this.longRtt) / rttMs),
    );
    let newLimit = this.estimatedLimit * gradient + this.config.queueSize;
    newLimit =
      this.estimatedLimit * (1 - this.config.smoothing) +
      newLimit * this.config.smoothing;
    this.estimatedLimit = Math.max(
      this.config.minLimit,
      Math.min(this.config.maxLimit, newLimit),
    );
  }

  getLimit(): number {
    return Math.floor(this.estimatedLimit);
  }

  getRttMinMs(): number {
    return Math.floor(this.longRtt);
  }

  getRttAvgMs(): number {
    return Math.floor(this.lastRtt);
  }
}

interface OriginState {
  readonly limit: Gradient2Limit;
  inFlight: number;
}

export class Gradient2ConcurrencyLimiter {
  private readonly origins = new Map<string, OriginState>();

  constructor(
    private readonly config: Gradient2Config = GRADIENT2_DEFAULT_CONFIG,
    registerSource = true,
  ) {
    if (registerSource) {
      setDownstreamConcurrencySource(() => this.snapshot());
    }
  }

  tryAcquire(origin: string): boolean {
    const state = this.state(origin);
    if (state.inFlight >= state.limit.getLimit()) {
      recordDownstreamLimitDropped(origin);
      return false;
    }
    state.inFlight += 1;
    return true;
  }

  release(origin: string, rttMs: number): void {
    const state = this.origins.get(origin);
    if (state === undefined || state.inFlight === 0) return;
    state.inFlight -= 1;
    state.limit.onSample(rttMs, state.inFlight + 1);
  }

  snapshot(): readonly DownstreamConcurrencySample[] {
    return [...this.origins.entries()].map(([origin, state]) => ({
      origin,
      limit: state.limit.getLimit(),
      inFlight: state.inFlight,
      rttMinMs: state.limit.getRttMinMs(),
      rttAvgMs: state.limit.getRttAvgMs(),
    }));
  }

  private state(origin: string): OriginState {
    let state = this.origins.get(origin);
    if (state === undefined) {
      state = {
        limit: new Gradient2Limit(this.config),
        inFlight: 0,
      };
      this.origins.set(origin, state);
    }
    return state;
  }
}
