import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
} from './metering-finalizer.port';
import { createMeteringFinalizeInput } from './metering-input';
import { claimRequestMetering } from './request-metering-state';

export async function finalizeRequestMetering(
  request: unknown,
  metering: MeteringFinalizerPort,
  input: Pick<MeteringFinalizeInput, 'outcome' | 'httpStatus' | 'totalMs'> &
    Partial<Pick<MeteringFinalizeInput, 'errorCode' | 'meteringStatus'>>,
): Promise<void> {
  const state = claimRequestMetering(request);
  const meteringInput =
    state === undefined ? undefined : createMeteringFinalizeInput(state, input);
  if (meteringInput !== undefined) {
    await metering.finalize(meteringInput).catch(() => undefined);
  }
}
