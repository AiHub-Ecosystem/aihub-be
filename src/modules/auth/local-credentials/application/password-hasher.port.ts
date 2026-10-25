export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  needsRehash(encodedHash: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
