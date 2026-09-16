import { type KeyLike, SignJWT, importPKCS8 } from 'jose';

import type {
  SandboxAssertionClaims,
  SandboxAssertionSignerPort,
} from '../application/sandbox-assertion-signer.port';
import type { IdentityConfigAlgorithm } from '../domain/organization-identity-config';
import type { SandboxAssertionConfig } from './sandbox-assertion.config';

/**
 * Signs sandbox assertions with the gateway's own key.
 *
 * The private key is imported once and kept in memory. It is never logged,
 * never returned, and never exposed through the port — callers hand over
 * claims and receive a token.
 */
export class JoseSandboxAssertionSigner implements SandboxAssertionSignerPort {
  readonly algorithm: IdentityConfigAlgorithm;

  private readonly keyId: string;
  private readonly privateKeyPem: string;
  private importedKey?: Promise<KeyLike>;

  constructor(config: SandboxAssertionConfig) {
    this.algorithm = config.algorithm;
    this.keyId = config.keyId;
    this.privateKeyPem = config.privateKeyPem;
  }

  async sign(claims: SandboxAssertionClaims): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: this.algorithm, kid: this.keyId })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .sign(await this.privateKey());
  }

  private privateKey(): Promise<KeyLike> {
    this.importedKey ??= importPKCS8(this.privateKeyPem, this.algorithm);
    return this.importedKey;
  }
}
