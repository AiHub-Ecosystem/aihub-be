export class CliUsageError extends Error {}

export function usageError(): never;
export function quotaOption(
  options: ReadonlyMap<string, string>,
  name: string,
): number | null;
export function booleanOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback?: boolean,
): boolean;
export function environmentOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback?: string,
): string;
