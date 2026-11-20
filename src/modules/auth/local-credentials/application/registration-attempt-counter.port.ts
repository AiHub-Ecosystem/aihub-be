export interface RegistrationAttemptCounterPort {
  count(input: { readonly email: string; readonly now: Date }): Promise<void>;
}

export const REGISTRATION_ATTEMPT_COUNTER = Symbol(
  'REGISTRATION_ATTEMPT_COUNTER',
);
