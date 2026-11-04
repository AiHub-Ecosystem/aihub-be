export {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  isValidPassword,
  normalizeEmail,
  normalizeLogin,
  normalizeRegistration,
  validatePassword,
} from '@/modules/auth/local-credentials/domain/local-auth';
export type {
  LocalAccountStatus,
  NormalizedRegistration,
  RegistrationInput,
} from '@/modules/auth/local-credentials/domain/local-auth';
