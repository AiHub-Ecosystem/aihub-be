import { AppError } from '@/common/errors/app-error';
import { InFlightCeiling } from './speaking-upload-ceiling';

describe('InFlightCeiling', () => {
  it('refuses past its maximum with the retryable concurrency error and frees a slot on leave', () => {
    const ceiling = new InFlightCeiling(2);
    const leaveFirst = ceiling.enter();
    ceiling.enter();

    let refusal: unknown;
    try {
      ceiling.enter();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({
      code: 'CONCURRENCY_LIMIT',
      retryable: true,
      // The hint is spread over [base, base + 1 s) (#1352).
      retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
    });

    leaveFirst();
    expect(() => ceiling.enter()).not.toThrow();
  });

  it('frees a slot once however often leave is called', () => {
    const ceiling = new InFlightCeiling(1);
    const leave = ceiling.enter();
    leave();
    leave();

    ceiling.enter();
    expect(() => ceiling.enter()).toThrow(AppError);
  });
});
