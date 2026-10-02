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
 * Read lazily per call rather than once at import time. Module decorators are
 * evaluated while `AppModule` is imported, which happens before `bootstrap`
 * loads `.env`, so anything resolved at import time would see an empty
 * environment in local development.
 */
export function readSandboxSigningMaterial(
  env: NodeJS.ProcessEnv = process.env,
): SandboxSigningMaterial | undefined {
  // A PEM carried in an environment variable usually arrives with its line
  // breaks escaped, and `importPKCS8` rejects the single-line form outright.
  const privateKeyPem = trimmed(
    env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY,
  ).replace(/\\n/g, '\n');
  const keyId = trimmed(env.AIHUB_SANDBOX_ASSERTION_KID);

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
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return trimmed(env.AIHUB_SANDBOX_ORG_IDS)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
