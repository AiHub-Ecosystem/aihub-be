/**
 * The Argon2id work factor, stated once.
 *
 * Three things have to agree on it and were never connected: the options the
 * hasher writes with, the hash a login spends work on for an address nobody
 * holds, and the PostgreSQL `CHECK` that refuses a hash written at anything
 * else. A verification costs what its hash string says, not what the caller
 * passed, so a cost raised in only one of the three either rejects new hashes at
 * the column or makes the unknown-address path measurably cheaper than the real
 * one, which is the whole thing the dummy hash exists to prevent.
 *
 * **Changing it.** First follow ADR-0080's measured memory gate; change the
 * numbers below only when that decision says to. Then do both of these in the
 * same change, because each one alone leaves the product inconsistent:
 *
 * 1. Write a new migration that drops `auth_identities_password_hash_check`
 *    and re-adds it using this module's `ARGON2ID_HASH_CONSTRAINT_PATTERN` for
 *    new hashes, while still accepting every work factor already present in
 *    stored hashes. Copy the generated pattern into the migration SQL; never
 *    edit a migration that may already have run. Keep old hashes verifiable and
 *    preserve ADR-0080's successful-login rehash before retiring an old factor.
 * 2. Re-run the database lane. `local-auth.migration.spec.ts` checks the newest
 *    migration that sets the constraint against this pattern, and
 *    `test/db/registration-password-hash.spec.ts` proves PostgreSQL accepts and
 *    verifies a real hash from the production hasher.
 *
 * Argon2 reads verification cost out of each stored hash, so hashes written
 * under a previous factor stay verifiable; this factor only governs new hashes.
 */

/** The algorithm and version the encoded prefix names. */
const ARGON2ID_ALGORITHM = 'argon2id';
const ARGON2ID_VERSION = 19;

/**
 * The numbers themselves. `memoryCost` is in kibibytes, as argon2 counts them:
 * 64 MiB of memory per verification, three passes, one lane.
 */
export const ARGON2ID_PARAMETERS = Object.freeze({
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
});

const memoryFactor = `m=${ARGON2ID_PARAMETERS.memoryCost}`;
const timeFactor = `t=${ARGON2ID_PARAMETERS.timeCost}`;
const parallelismFactor = `p=${ARGON2ID_PARAMETERS.parallelism}`;

/**
 * The factor as the installed argon2 writes it: memory, parallelism, then time.
 * Only this order appears in a real hash, but the constraint accepts any of
 * them, because an argon2 upgrade once changed the order and rejected every hash
 * the application had written.
 */
export const ARGON2ID_WORK_FACTOR = `${memoryFactor},${parallelismFactor},${timeFactor}`;

/** Everything up to and including the salt separator of an encoded hash. */
export const ARGON2ID_ENCODED_PREFIX = `$${ARGON2ID_ALGORITHM}$v=${ARGON2ID_VERSION}$${ARGON2ID_WORK_FACTOR}$`;

function either(first: string, second: string): string {
  return `(${first}|${second})`;
}

/**
 * The six orderings of the three factors: each one leads, and the other two
 * follow in either order, which is how argon2 has written them across versions.
 */
function orderings(factors: readonly [string, string, string]): string {
  const parts: string[] = [];
  for (let first = 0; first < factors.length; first += 1) {
    const rest = factors.filter((_, index) => index !== first);
    parts.push(
      `${factors[first]},${either(rest.join(','), [...rest].reverse().join(','))}`,
    );
  }
  return parts.join('|');
}

/**
 * The `CHECK` the column carries, as a regular expression source string. It
 * pins the algorithm, the version and every ordering of the work factor, and
 * leaves the salt and digest lengths open because the column does not check
 * them. A migration interpolates this into its SQL, which is what keeps the
 * constraint and these parameters from drifting apart.
 */
export const ARGON2ID_HASH_CONSTRAINT_PATTERN =
  `^\\$${ARGON2ID_ALGORITHM}\\$v=${ARGON2ID_VERSION}\\$` +
  `(${orderings([memoryFactor, timeFactor, parallelismFactor])})\\$`;

/**
 * What a login verifies against when the address is not registered: a hash at
 * the same work factor, of a passphrase nobody holds, so the verification runs
 * at full cost and always fails. The salt and digest are the only parts that are
 * literal — they carry no parameter, and `argon2.needsRehash` reads the factor
 * out of the prefix above, which is why a change of factor reaches this hash
 * without anyone editing it.
 */
export const ARGON2ID_DUMMY_HASH = `${ARGON2ID_ENCODED_PREFIX}SoHl8YUBzXgiAZ4xlgNZyg$qwZIFOa2OcIOgiHLRYImWLsza4k9/T4ZZvvhiWrD41k`;
