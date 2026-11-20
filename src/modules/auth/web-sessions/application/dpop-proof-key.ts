import { isRecord } from '@/common/is-record';

/** A client's public proof key as submitted, before it is checked. */
export interface DpopProofKeyInput {
  readonly kty?: string | undefined;
  readonly crv?: string | undefined;
  readonly x?: string | undefined;
  readonly y?: string | undefined;
  readonly d?: string | undefined;
}

export interface DpopPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** Only an ES256 P-256 public key qualifies as a Client proof key; a private member never does. */
export function isDpopPublicJwk(value: unknown): value is DpopPublicJwk {
  return (
    isRecord(value) &&
    value['kty'] === 'EC' &&
    value['crv'] === 'P-256' &&
    typeof value['x'] === 'string' &&
    typeof value['y'] === 'string' &&
    !('d' in value)
  );
}
