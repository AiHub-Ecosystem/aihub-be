/**
 * ADR-0027 as amended (#447): a key records who created it and who last
 * rotated it, so a removed manager's credentials stay attributable for as long
 * as the keys do instead of only for as long as the audit trail retains the
 * `api_key.created` and `api_key.rotated` events.
 *
 * The two handling names are joined rather than stored as text so a renamed
 * account cannot leave a key attributed to a name nobody holds.
 */

/** The same names, aliased from SQL for the locked rows the mutation paths read. */
export const ATTRIBUTION_COLUMNS_SQL = `
  api_key.created_by AS "createdByUserId",
  creator.username AS "createdByUsername",
  rotator.username AS "lastRotatedByUsername"
`;

export const API_KEY_ATTRIBUTION_JOINS_SQL = `
  LEFT JOIN user_accounts AS creator ON creator.id = api_key.created_by
  LEFT JOIN user_accounts AS rotator ON rotator.id = api_key.last_rotated_by
`;

/**
 * A handling attribution as the row reports it: `null` when nobody is
 * recorded (a key minted before migration 0063, or one nobody rotated), and
 * `undefined` only when the value is malformed. Keeping the two apart is what
 * lets the published view say "unknown" instead of naming the wrong account.
 */
export function handlingUsername(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const raw = value[key];
  if (raw === null || raw === undefined) {
    return null;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
