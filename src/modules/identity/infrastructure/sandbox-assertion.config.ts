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
