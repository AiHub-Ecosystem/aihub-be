import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a stable health response', () => {
    const controller = new HealthController();

    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
