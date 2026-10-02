export interface CreateOperatorApiKeyInput {
  readonly organizationId: string;
  /** The operator's own AIHUB User Account, named by exact username. */
  readonly actorUsername: string;
  readonly apiKeyId: string;
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly requestId: string;
  readonly occurredAt: Date;
}

export type CreateOperatorApiKeyResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'organization_unavailable' }
  | { readonly kind: 'actor_invalid' };

export interface RevokeOperatorApiKeyInput {
  readonly apiKeyId: string;
  /** The operator's own AIHUB User Account, named by exact username. */
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

/**
 * Both applied outcomes carry the key's hash so the caller can purge its
 * identity cache entry. A repeat purges too: rerunning the command is how an
 * operator closes a window a failed purge left open.
 */
export type RevokeOperatorApiKeyResult =
  | {
      readonly kind: 'revoked' | 'unchanged';
      readonly keyHash: string;
    }
  | { readonly kind: 'key_not_found' }
  | { readonly kind: 'actor_invalid' };

/**
 * The operator's side of key issuance and revocation. Each act and its
 * Organization Audit Event commit together. Unlike the Bearer path, creation is
 * not gated on Entitlements or the key cap, and revocation is not gated on the
 * Organization being active: an operator revoking a leaked credential must be
 * able to do so for a suspended Organization.
 */
export interface OperatorApiKeyPort {
  createApiKey(
    input: CreateOperatorApiKeyInput,
  ): Promise<CreateOperatorApiKeyResult>;
  revokeApiKey(
    input: RevokeOperatorApiKeyInput,
  ): Promise<RevokeOperatorApiKeyResult>;
  close(): Promise<void>;
}
