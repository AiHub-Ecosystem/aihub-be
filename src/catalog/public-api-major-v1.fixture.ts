import {
  type PublicApiMajorDef,
  findPublicApiMajor,
} from './public-api-majors';

/**
 * The released `/v1` major for specs that assert the `/v1` contract. The
 * document builder defaults to the newest major, so a spec that means `/v1`
 * names it instead of relying on that default.
 */
export function publicApiMajorV1(): PublicApiMajorDef {
  const major = findPublicApiMajor(1);
  if (major === undefined)
    throw new Error('Public API major 1 is not released');
  return major;
}
