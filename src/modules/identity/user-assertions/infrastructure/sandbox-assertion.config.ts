import { createPrivateKey, createPublicKey } from 'node:crypto';

import type {
  RuntimeConfiguration,
  RuntimeConnectionConfiguration,
} from '@/config/runtime-configuration';
import type { IdentityConfigAlgorithm } from '@/modules/identity/domain/organization-identity-config';

/**
 * The key this deployment signs sandbox assertions with.
 *
 * `RS256` is fixed rather than configurable. The verifier accepts `RS256` and
 * `ES256`, but nothing has asked to sign sandbox tokens with the second, and a
 * knob whose only wrong setting produces tokens that never verify is a knob
 * worth not having. Introduce it when an organization actually needs it.
 */
export interface SandboxSigningMaterial {
  readonly privateKeyPem: string;
  readonly keyId: string;
  readonly algorithm: IdentityConfigAlgorithm;
}

const ALGORITHM: IdentityConfigAlgorithm = 'RS256';

// #638 establishes the floor for the User Access JWT signing key; this is the
// same floor for the sibling sandbox-assertion key until that issue names one.
const MIN_SANDBOX_ASSERTION_MODULUS_BITS = 2048;

// A memo keeps the per-request policy and mint paths from re-parsing the same
// key; a key that fails is re-checked and re-refused on every call.
let validatedPrivateKeyPem: string | undefined;

function assertUsableRsaSigningKey(privateKeyPem: string): void {
  if (validatedPrivateKeyPem === privateKeyPem) {
    return;
  }
  let modulusBits: number;
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error('the key is not RSA');
    }
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (typeof jwk.n !== 'string') {
      throw new Error('the key carries no modulus');
    }
    modulusBits = Buffer.from(jwk.n, 'base64url').length * 8;
  } catch (error) {
    throw new Error(
      `AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY is not a usable RS256 signing key: ${
        error instanceof Error ? error.message : 'unknown reason'
      }`,
    );
  }
  if (modulusBits < MIN_SANDBOX_ASSERTION_MODULUS_BITS) {
    throw new Error(
      `AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY carries a ${modulusBits}-bit RSA key; sandbox assertions need at least ${MIN_SANDBOX_ASSERTION_MODULUS_BITS} bits.`,
    );
  }
  validatedPrivateKeyPem = privateKeyPem;
}

function trimmed(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

/**
 * Reads the sandbox signing key, or returns `undefined` when this deployment
 * has none.
 *
 * Absence is a supported state, not an error: a deployment that never wanted a
 * sandbox must start and serve every other operation exactly as before, with
 * the mint route simply not answering. Partial configuration is treated the
 * same way — half a key pair cannot sign anything, so there is nothing to
 * usefully enable.
 *
 * Read lazily per call from the injected runtime connection configuration so
 * importing `AppModule` never reads secret material during module evaluation.
 */
export function readSandboxSigningMaterial(
  configuration: Pick<
    RuntimeConnectionConfiguration,
    'sandboxAssertionPrivateKey' | 'sandboxAssertionKeyId'
  >,
): SandboxSigningMaterial | undefined {
  // A PEM carried in an environment variable usually arrives with its line
  // breaks escaped, and `importPKCS8` rejects the single-line form outright.
  const privateKeyPem = trimmed(
    configuration.sandboxAssertionPrivateKey,
  ).replace(/\\n/g, '\n');
  const keyId = trimmed(configuration.sandboxAssertionKeyId);

  if (privateKeyPem.length === 0 || keyId.length === 0) {
    return undefined;
  }

  assertUsableRsaSigningKey(privateKeyPem);

  return { privateKeyPem, keyId, algorithm: ALGORITHM };
}

/**
 * The organizations permitted to mint. Kept apart from the signing material
 * because they answer different questions — who may ask, and what the answer
 * is signed with — and because handing the allowlist to a signer that never
 * reads it invites the two to be confused for each other.
 */
export function readSandboxOrganizationIds(
  configuration: Pick<RuntimeConfiguration, 'AIHUB_SANDBOX_ORG_IDS'>,
): readonly string[] {
  return trimmed(configuration.AIHUB_SANDBOX_ORG_IDS)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
