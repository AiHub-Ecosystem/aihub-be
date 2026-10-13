import { effectiveSandboxAllowance } from './effective-sandbox-allowance';

describe('effectiveSandboxAllowance', () => {
  it('uses a month override, including zero', () => {
    expect(effectiveSandboxAllowance(0, 5)).toBe(0);
    expect(effectiveSandboxAllowance(20, 5)).toBe(20);
  });

  it('falls back to the persisted default or reports missing policy', () => {
    expect(effectiveSandboxAllowance(null, 5)).toBe(5);
    expect(effectiveSandboxAllowance(null, null)).toBeNull();
  });
});
