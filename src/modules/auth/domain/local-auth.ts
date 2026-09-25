export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_CODE_POINTS = 128;

export type LocalAccountStatus = 'pending_verification' | 'active' | 'disabled';

export interface RegistrationInput {
  readonly email: string;
  readonly username: string;
  readonly password: string;
}

export interface NormalizedRegistration {
  readonly email: string;
  readonly username: string;
  readonly password: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export interface NormalizedLogin {
  readonly email: string;
  readonly password: string;
}

export class LocalAuthValidationError extends Error {
  constructor(message = 'local auth input is invalid') {
    super(message);
    this.name = 'LocalAuthValidationError';
  }
}

export function normalizeEmail(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
  ) {
    throw new LocalAuthValidationError();
  }
  return normalized;
}

export function normalizeUsername(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/u.test(normalized)) {
    throw new LocalAuthValidationError();
  }
  return normalized;
}

export function isValidPassword(value: string): boolean {
  const length = [...value].length;
  return (
    length >= PASSWORD_MIN_CODE_POINTS && length <= PASSWORD_MAX_CODE_POINTS
  );
}

export function validatePassword(value: string): string {
  if (!isValidPassword(value)) {
    throw new LocalAuthValidationError();
  }
  return value;
}

export function normalizeRegistration(
  input: RegistrationInput,
): NormalizedRegistration {
  return {
    email: normalizeEmail(input.email),
    username: normalizeUsername(input.username),
    password: validatePassword(input.password),
  };
}

export function normalizeLogin(input: LoginInput): NormalizedLogin {
  return {
    email: normalizeEmail(input.email),
    password: validatePassword(input.password),
  };
}

export function canTransitionToActive(status: LocalAccountStatus): boolean {
  return status === 'pending_verification';
}
