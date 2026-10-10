import type { InsertEmailDeliveryRequestInput } from './email-delivery-request.port';

export interface AuthMfaFactorRecord {
  readonly factorId: string;
  readonly userId: string;
  readonly email: string;
  readonly keyId: string;
  readonly ciphertext: string;
}

export type MfaSessionProof =
  | { readonly kind: 'totp'; readonly factorId: string }
  | { readonly kind: 'recovery'; readonly codeHash: string };

export interface AuthMfaRepositoryPort {
  findActiveFactor(userId: string): Promise<AuthMfaFactorRecord | undefined>;
  findPendingFactor(userId: string): Promise<AuthMfaFactorRecord | undefined>;
  savePendingFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly keyId: string;
    readonly ciphertext: string;
    readonly now: Date;
  }): Promise<boolean>;
  confirmFactor(input: {
    readonly factorId: string;
    readonly userId: string;
    readonly email: string;
    readonly recoveryCodeHashes: readonly string[];
    readonly emailDelivery: InsertEmailDeliveryRequestInput;
    readonly now: Date;
  }): Promise<boolean>;
  removeFactor(input: {
    readonly factorId: string | undefined;
    readonly userId: string;
    readonly email: string;
    readonly expectedPasswordHash?: string;
    readonly emailDelivery: InsertEmailDeliveryRequestInput | undefined;
    readonly now: Date;
  }): Promise<boolean>;
}

export const AUTH_MFA_REPOSITORY = Symbol('AUTH_MFA_REPOSITORY');
export const AUTH_MFA_ID = Symbol('AUTH_MFA_ID');

export interface AuthMfaCipherPort {
  encrypt(
    plaintext: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): { readonly keyId: string; readonly ciphertext: string };
  decrypt(
    keyId: string,
    ciphertext: string,
    binding: { readonly userId: string; readonly factorId: string },
  ): string;
}

export const AUTH_MFA_CIPHER = Symbol('AUTH_MFA_CIPHER');

export interface AuthMfaServicePort {
  loginProof(
    userId: string,
    code: string | undefined,
  ): Promise<
    | { readonly kind: 'none' }
    | { readonly kind: 'required' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'proved'; readonly proof: MfaSessionProof }
  >;
  beginEnrollment(input: {
    readonly userId: string;
    readonly password: string;
    readonly ip: string;
  }): Promise<{ readonly secret: string; readonly otpauthUri: string }>;
  confirmEnrollment(input: {
    readonly userId: string;
    readonly code: string;
    readonly ip: string;
  }): Promise<readonly string[]>;
  removeFactor(input: {
    readonly userId: string;
    readonly proof: { readonly password: string } | { readonly code: string };
    readonly ip: string;
  }): Promise<void>;
}

export const AUTH_MFA_SERVICE = Symbol('AUTH_MFA_SERVICE');

export interface AuthMfaKeyring {
  readonly currentKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}
