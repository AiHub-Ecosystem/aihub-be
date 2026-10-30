import { invalidRequest } from '@/common/errors/invalid-request';
import type { IdentityConfigPrecondition } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

type RequestHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** One quoted positive integer. A weak tag, a list, and `*` are not accepted. */
const STRONG_REVISION_TAG = /^"([1-9]\d*)"$/;

const IF_MATCH_REFUSAL = 'If-Match must be one quoted revision such as "7"';
const IF_NONE_MATCH_REFUSAL = 'If-None-Match must be *';

/** The `ETag` value of a stored configuration. Clients treat it as opaque. */
export function identityConfigEtag(revision: string): string {
  return `"${revision}"`;
}

/**
 * Reads the optional precondition of `PUT .../identity-config` (ADR-0132).
 * Neither header means an unconditional write. `If-Match` names the revision
 * the caller read; `If-None-Match: *` asks to create only when no configuration
 * exists. Anything else is refused rather than guessed at, since a malformed
 * precondition silently ignored would turn a protected write into a blind one.
 */
export function parseIdentityConfigPrecondition(
  headers: RequestHeaders,
): IdentityConfigPrecondition | undefined {
  const ifMatch = headers['if-match'];
  const ifNoneMatch = headers['if-none-match'];

  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw invalidRequest(
      undefined,
      { if_match: 'Send either If-Match or If-None-Match, not both' },
      'Identity configuration write sent both preconditions',
    );
  }

  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch !== '*') {
      throw invalidRequest(
        undefined,
        { if_none_match: IF_NONE_MATCH_REFUSAL },
        'Identity configuration If-None-Match is not *',
      );
    }
    return { kind: 'absent' };
  }

  if (ifMatch === undefined) {
    return undefined;
  }

  const revision =
    typeof ifMatch === 'string' ? STRONG_REVISION_TAG.exec(ifMatch)?.[1] : null;
  if (revision === undefined || revision === null) {
    throw invalidRequest(
      undefined,
      { if_match: IF_MATCH_REFUSAL },
      'Identity configuration If-Match is not one strong revision tag',
    );
  }
  return { kind: 'revision', revision };
}
