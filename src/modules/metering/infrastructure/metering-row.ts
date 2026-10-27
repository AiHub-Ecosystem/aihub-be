/**
 * The count a `::bigint` aggregate yields, or `undefined` when it is not a safe
 * non-negative integer. Prisma's raw path returns `bigint` where `pg` returned a
 * decimal string, and both are accepted.
 */

export { safeNonNegativeCount } from '@/modules/metering/application/metering-count';
