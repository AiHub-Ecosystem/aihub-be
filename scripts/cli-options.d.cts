// Hand-written because the module it describes is plain CommonJS: `cli.mjs`
// imports it at runtime, so it cannot be TypeScript, but its spec is.
export declare class CliUsageError extends Error {}
export declare function usageError(): never;
export declare function quotaOption(
  options: ReadonlyMap<string, string>,
  name: string,
): number | null;
export declare function booleanOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback?: boolean,
): boolean;
