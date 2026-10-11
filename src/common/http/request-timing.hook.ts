interface TimingHookableInstance {
  addHook(...args: never[]): unknown;
}

interface TimedRequest {
  readonly raw: unknown;
}

interface RequestTiming {
  readonly startedAt: number;
  admissionMs?: number;
}

const timingByRequest = new WeakMap<object, RequestTiming>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

export function registerRequestTiming(instance: TimingHookableInstance): void {
  Reflect.apply(instance.addHook, instance, [
    'onRequest',
    (request: TimedRequest, _reply: unknown, done: () => void): void => {
      if (isObject(request.raw)) {
        timingByRequest.set(request.raw, { startedAt: performance.now() });
      }
      done();
    },
  ]);
}

export function requestDurationMs(
  rawRequest: unknown,
  fallbackMs: number,
): number {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  return timing === undefined
    ? Math.max(0, Math.round(fallbackMs))
    : Math.max(0, Math.round(performance.now() - timing.startedAt));
}

/** Called after guards and body validation, before gateway orchestration starts. */
export function markRequestAdmission(rawRequest: unknown): void {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  if (timing !== undefined && timing.admissionMs === undefined) {
    timing.admissionMs = Math.max(
      0,
      Math.round(performance.now() - timing.startedAt),
    );
  }
}

export function requestAdmissionMs(rawRequest: unknown): number | undefined {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  return timing?.admissionMs;
}
