import {
  ARGON2ID_ENCODED_PREFIX,
  ARGON2ID_HASH_CONSTRAINT_PATTERN,
  ARGON2ID_PARAMETERS,
} from './argon2id-parameters';

const CONSTRAINT_PATTERN = new RegExp(ARGON2ID_HASH_CONSTRAINT_PATTERN);

/**
 * The work factor is stated in three places that were never connected: the
 * hasher's options, the hash a login spends work on for an address nobody
 * holds, and the PostgreSQL `CHECK` that refuses anything else. Raising one
 * without the others leaves new hashes unwritable, leaves the unknown-email
 * defence measurably cheaper than the real path, or both.
 */
describe('the Argon2id work factor', () => {
  describe('the database constraint', () => {
    it('accepts the encoded prefix generated from the owned parameters', () => {
      expect(
        CONSTRAINT_PATTERN.test(
          `$argon2id$v=19$m=${ARGON2ID_PARAMETERS.memoryCost},p=${ARGON2ID_PARAMETERS.parallelism},t=${ARGON2ID_PARAMETERS.timeCost}$c2FsdHNhbHQ$aGFzaA`,
        ),
      ).toBe(true);
    });

    it('accepts every order of the same parameters', () => {
      const parameters = ARGON2ID_PARAMETERS;
      for (const order of [
        `m=${parameters.memoryCost},p=${parameters.parallelism},t=${parameters.timeCost}`,
        `m=${parameters.memoryCost},t=${parameters.timeCost},p=${parameters.parallelism}`,
        `t=${parameters.timeCost},m=${parameters.memoryCost},p=${parameters.parallelism}`,
        `t=${parameters.timeCost},p=${parameters.parallelism},m=${parameters.memoryCost}`,
        `p=${parameters.parallelism},m=${parameters.memoryCost},t=${parameters.timeCost}`,
        `p=${parameters.parallelism},t=${parameters.timeCost},m=${parameters.memoryCost}`,
      ]) {
        expect(
          CONSTRAINT_PATTERN.test(`$argon2id$v=19$${order}$c2FsdHNhbHQ$aGFzaA`),
        ).toBe(true);
      }
    });

    it('refuses a hash written at a different work factor', () => {
      const weaker = `${ARGON2ID_ENCODED_PREFIX}c2FsdHNhbHQ$aGFzaA`.replace(
        `m=${ARGON2ID_PARAMETERS.memoryCost}`,
        `m=${ARGON2ID_PARAMETERS.memoryCost * 2}`,
      );

      expect(CONSTRAINT_PATTERN.test(weaker)).toBe(false);
    });

    it('refuses a hash written by another algorithm', () => {
      const wrongAlgorithm =
        `${ARGON2ID_ENCODED_PREFIX}c2FsdHNhbHQ$aGFzaA`.replace(
          '$argon2id$',
          '$argon2i$',
        );

      expect(CONSTRAINT_PATTERN.test(wrongAlgorithm)).toBe(false);
    });
  });
});
