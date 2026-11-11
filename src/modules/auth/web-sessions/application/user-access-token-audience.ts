export function userAccessTokenAudience(
  databaseScope: 'production' | 'sandbox',
): string {
  return `aihub-user-api:${databaseScope}`;
}
