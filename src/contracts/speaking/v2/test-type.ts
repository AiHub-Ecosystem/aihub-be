import type { SpeakingV2TestType } from './response.shared';

export function isSpeakingV2TestType(
  value: string,
): value is SpeakingV2TestType {
  return value === 'practice' || value === 'full_test';
}

export function toProviderSpeakingTestType(
  testType: SpeakingV2TestType,
): 'Practice' | 'Full-test' {
  return testType === 'practice' ? 'Practice' : 'Full-test';
}

export function fromProviderSpeakingTestType(
  testType: unknown,
): SpeakingV2TestType | undefined {
  if (testType === 'practice' || testType === 'Practice') {
    return 'practice';
  }
  if (testType === 'full_test' || testType === 'Full-test') {
    return 'full_test';
  }
  return undefined;
}
