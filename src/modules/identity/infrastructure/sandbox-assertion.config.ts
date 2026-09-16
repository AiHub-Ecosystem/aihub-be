import {
  IDENTITY_CONFIG_ALGORITHMS,
  type IdentityConfigAlgorithm,
} from '../domain/organization-identity-config';

export interface SandboxAssertionConfig {
  /** Organizations permitted to mint. Everything else is rejected. */
  readonly organizationIds: readonly string[];
  readonly privateKeyPem: string;
  readonly keyId: string;
  readonly algorithm: IdentityConfigAlgorithm;
}

const DEFAULT_ALGORITHM: IdentityConfigAlgorithm = 'RS256';

function trimmed(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

function isAlgorithm(value: string): value is IdentityConfigAlgorithm {
  return (IDENTITY_CONFIG_ALGORITHMS as readonly string[]).includes(value);
}

/**
 * Reads sandbox signing material from the environment, or returns `undefined`
 * when this deployment has no sandbox.
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
export function readSandboxAssertionConfig(
  env: NodeJS.ProcessEnv = process.env,
): SandboxAssertionConfig | undefined {
  const organizationIds = trimmed(env.AIHUB_SANDBOX_ORG_IDS)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  // A PEM carried in an environment variable usually arrives with its line
  // breaks escaped, and `importPKCS8` rejects the single-line form outright.
  const privateKeyPem = trimmed(
    env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY,
  ).replace(/\\n/g, '\n');
  const keyId = trimmed(env.AIHUB_SANDBOX_ASSERTION_KID);
  const rawAlgorithm = trimmed(env.AIHUB_SANDBOX_ASSERTION_ALG);

  if (
    organizationIds.length === 0 ||
    privateKeyPem.length === 0 ||
    keyId.length === 0
  ) {
    return undefined;
  }

  // An unrecognised algorithm is a typo in a security-relevant setting. Falling
  // back to the default would hide it behind tokens that never verify.
  if (rawAlgorithm.length > 0 && !isAlgorithm(rawAlgorithm)) {
    return undefined;
  }

  const algorithm: IdentityConfigAlgorithm = isAlgorithm(rawAlgorithm)
    ? rawAlgorithm
    : DEFAULT_ALGORITHM;

  return { organizationIds, privateKeyPem, keyId, algorithm };
}
