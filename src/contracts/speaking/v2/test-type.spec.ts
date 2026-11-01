import {
  fromProviderSpeakingTestType,
  toProviderSpeakingTestType,
} from './test-type';

describe('Speaking v2 test_type conversion', () => {
  it.each([
    ['practice', 'Practice'],
    ['full_test', 'Full-test'],
  ] as const)(
    'converts public %s to provider spelling',
    (publicValue, providerValue) => {
      expect(toProviderSpeakingTestType(publicValue)).toBe(providerValue);
    },
  );

  it('converts the captured provider echo to the public spelling', () => {
    expect(fromProviderSpeakingTestType('full_test')).toBe('full_test');
  });
});
