import { type CryptoKey, type KeyObject, SignJWT, importPKCS8 } from 'jose';

import { AppError } from '@/common/errors/app-error';
import type {
  SandboxAssertionClaims,
  SandboxAssertionSignerPort,
} from '@/modules/identity/user-assertions/application/sandbox-assertion-signer.port';
import { type SandboxSigningMaterial } from './sandbox-assertion.config';

function notConfigured(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox assertion configuration is invalid',
    retryable: false,
  });
}

/**
 * Signs sandbox assertions with the gateway's own key.
 *
 * The material is resolved on first use rather than at construction, because
 * this provider is built while the module graph is assembled and a deployment
 * without a sandbox must still assemble. Reaching a signer that has nothing to
 * sign with is a configuration fault, and it says so rather than handing back
 * a token nobody can verify.
 *
 * The private key is imported once and kept in memory. It is never logged,
 * never returned, and never exposed through the port — callers hand over
 * claims and receive a token.
 */
export class JoseSandboxAssertionSigner implements SandboxAssertionSignerPort {
  private importedKey?: Promise<CryptoKey | KeyObject>;

  constructor(
    private readonly readMaterial: () => SandboxSigningMaterial | undefined,
  ) {}

  get algorithm(): SandboxAssertionSignerPort['algorithm'] {
    return this.material().algorithm;
  }

  async sign(claims: SandboxAssertionClaims): Promise<string> {
    const material = this.material();
    return new SignJWT({})
      .setProtectedHeader({ alg: material.algorithm, kid: material.keyId })
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .sign(await this.privateKey(material));
  }

  private material(): SandboxSigningMaterial {
    const material = this.readMaterial();
    if (material === undefined) {
      throw notConfigured();
    }

    return material;
  }

  private privateKey(
    material: SandboxSigningMaterial,
  ): Promise<CryptoKey | KeyObject> {
    this.importedKey ??= importPKCS8(
      material.privateKeyPem,
      material.algorithm,
    );
    return this.importedKey;
  }
}
