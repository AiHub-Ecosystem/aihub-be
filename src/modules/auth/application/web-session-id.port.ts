/**
 * The minter for a `wbs_`-prefixed Web Session row id. Bound once in the
 * module composition root from the same binding the token issuer uses, so the
 * row's id and its token share one namespace and one clock.
 */
export const WEB_SESSION_ID = Symbol('WEB_SESSION_ID');
