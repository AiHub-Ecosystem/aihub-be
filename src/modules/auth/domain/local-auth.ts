import { decodePunycode } from './punycode';
import { hasOneWritingSystem } from './script-mix';

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

// RFC 5322 atext plus the dot between atoms: the unquoted local parts a
// provider delivers without SMTPUTF8. The input is already lower-cased.
const LOCAL_PART =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// A real top-level domain: letters, or an IDNA one in punycode. Digits alone
// would be read as an IPv4 address by a host parser.
const TOP_LEVEL = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;
// What a typed domain may hold before a host parser sees it. Anything else
// (a percent escape, a slash, a colon, an at sign) could make the parser read
// a different host than the one typed.
const DOMAIN_CHARACTERS = /^[\p{L}\p{M}\p{N}.-]+$/u;

/** The domain as the WHATWG host parser writes it: lower case, IDNA ASCII. */
function asciiHost(domain: string): string | undefined {
  if (!DOMAIN_CHARACTERS.test(domain)) return undefined;
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return undefined;
  }
}

function isDeliverableLabel(label: string): boolean {
  if (label.length > 63 || !ASCII_LABEL.test(label)) return false;
  if (!label.startsWith('xn--')) {
    // Hyphens in the third and fourth places are reserved for punycode.
    return label.slice(2, 4) !== '--';
  }
  const decoded = decodePunycode(label.slice(4));
  return decoded !== undefined && hasOneWritingSystem(decoded);
}

/**
 * The domain in its one IDNA form (UTS 46, ASCII/punycode), or `undefined` when
 * no mail system would deliver to it. Case, fullwidth forms and Unicode all map
 * to that form, so `bücher.de` and `xn--bcher-kva.de` are one domain. A label
 * that mixes scripts (a Cyrillic `а` among Latin letters) is refused whether it
 * was typed or arrived as punycode, because it reads as another domain.
 */
function canonicalDomain(domain: string): string | undefined {
  const ascii = asciiHost(domain);
  const labels = ascii?.split('.') ?? [];
  return ascii !== undefined &&
    labels.length >= 2 &&
    TOP_LEVEL.test(labels.at(-1) ?? '') &&
    labels.every(isDeliverableLabel)
    ? ascii
    : undefined;
}

/**
 * One mailbox has one address in AIHUB (ADR-0124). The local part is lower-cased
 * ASCII, the characters a provider delivers without SMTPUTF8; the domain is its
 * IDNA ASCII form. Everything else is refused with the same validation error,
 * which depends on the input alone and so names no account.
 */
export function normalizeEmail(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at < 1) throw new LocalAuthValidationError();
  const local = normalized.slice(0, at);
  const domain = canonicalDomain(normalized.slice(at + 1));
  if (domain === undefined || !LOCAL_PART.test(local) || local.length > 64) {
    throw new LocalAuthValidationError();
  }
  const address = `${local}@${domain}`;
  if (address.length > 254) throw new LocalAuthValidationError();
  return address;
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
