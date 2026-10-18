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

const UTF8 = new TextEncoder();

function utf8Bytes(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Unicode stays allowed in both parts; what is refused is an address that no
 * mail system delivers or that names a mailbox under a second spelling: a
 * control or invisible format character, an empty or dotted-at-the-edge local
 * part, a domain label that is not a host name label, a trailing dot, or more
 * than the 64-byte local part and 254-byte path that SMTP carries.
 */
export function normalizeEmail(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  const at = normalized.indexOf('@');
  const local = normalized.slice(0, at);
  const labels = normalized.slice(at + 1).split('.');
  if (
    at < 1 ||
    utf8Bytes(normalized) > 254 ||
    utf8Bytes(local) > 64 ||
    /[\s@\p{Cc}\p{Cf}]/u.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    labels.length < 2 ||
    !labels.every(
      (label) =>
        utf8Bytes(label) <= 63 &&
        /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u.test(
          label,
        ),
    )
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
  const length = Array.from(value).length;
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
