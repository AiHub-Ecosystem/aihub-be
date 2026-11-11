export function userAccessTokenAudience(databaseScope: string): string {
  return `aihub-user-api:${databaseScope}`;
}
