import type { OperationId } from '../../catalog/operation-id';
import type { MeteringTelemetry, RequestMeteringState } from './metering.types';

const stateByRequest = new WeakMap<object, RequestMeteringState>();

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

export function initializeRequestMetering(
  request: object,
  receivedAt: Date = new Date(),
  startedAt: number = performance.now(),
): RequestMeteringState {
  const existing = stateByRequest.get(request);
  if (existing !== undefined) {
    return existing;
  }

  const state: RequestMeteringState = {
    requestId: requestIdOf(request),
    receivedAt: new Date(receivedAt.getTime()),
    startedAt,
    finalized: false,
  };
  stateByRequest.set(request, state);
  return state;
}

function requestIdOf(request: object): string {
  if ('id' in request && typeof request.id === 'string') {
    return request.id;
  }
  return '';
}

export function getRequestMeteringState(
  request: unknown,
): RequestMeteringState | undefined {
  return isObject(request) ? stateByRequest.get(request) : undefined;
}

export function setRequestMeteringIdentity(
  request: object,
  input: {
    readonly operation: OperationId;
    readonly organizationId: string;
    readonly apiKeyId: string;
    readonly environment: string;
  },
): RequestMeteringState {
  const state = initializeRequestMetering(request);
  state.operation = input.operation;
  state.organizationId = input.organizationId;
  state.apiKeyId = input.apiKeyId;
  state.environment = input.environment;
  return state;
}

export function setRequestMeteringActor(
  request: object,
  actorId: string,
): RequestMeteringState {
  const state = initializeRequestMetering(request);
  state.actorId = actorId;
  return state;
}

export function setRequestMeteringTelemetry(
  request: object,
  operation: OperationId,
  telemetry: MeteringTelemetry & {
    readonly downstreamMs: number;
    readonly idempotentReplay?: boolean;
    readonly modelCalled?: boolean;
  },
): RequestMeteringState {
  const state = initializeRequestMetering(request);
  state.operation = operation;
  state.downstreamMs = telemetry.downstreamMs;
  if (telemetry.aiProcessingMs !== undefined) {
    state.aiProcessingMs = telemetry.aiProcessingMs;
  }
  if (telemetry.usage !== undefined) {
    state.usage = telemetry.usage;
  }
  if (telemetry.models !== undefined) {
    state.models = telemetry.models;
  }
  if (telemetry.idempotentReplay !== undefined) {
    state.idempotentReplay = telemetry.idempotentReplay;
  }
  if (telemetry.modelCalled !== undefined) {
    state.modelCalled = telemetry.modelCalled;
  }
  return state;
}

export function setRequestMeteringQuotaUnverified(request: object): void {
  initializeRequestMetering(request).quotaUnverified = true;
}

export function claimRequestMetering(
  request: unknown,
): RequestMeteringState | undefined {
  const state = getRequestMeteringState(request);
  if (state === undefined || state.finalized) {
    return undefined;
  }

  state.finalized = true;
  return state;
}

export function elapsedRequestMs(state: RequestMeteringState): number {
  return Math.max(0, Math.round(performance.now() - state.startedAt));
}

export interface MeteringStartHookableInstance {
  addHook(
    name: 'onRequest',
    handler: (request: object, reply: unknown, done: () => void) => void,
  ): void;
}

export function registerRequestMeteringStart(
  instance: MeteringStartHookableInstance,
): void {
  instance.addHook('onRequest', (request, _reply, done) => {
    initializeRequestMetering(request);
    done();
  });
}
