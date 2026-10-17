/**
 * The Customer Web BFF's static client secret.
 *
 * Every Web Session route requires it in `X-AIHUB-Client-Secret`, compared in
 * constant time before any credential or session lookup. `resolve()` returns
 * `undefined` for a deployment that provisioned none, which the route group
 * answers `503` for: unprovisioned is not open.
 */
export interface WebSessionClientSecretPort {
  resolve(): string | undefined;
}

export const WEB_SESSION_CLIENT_SECRET = Symbol('WEB_SESSION_CLIENT_SECRET');
