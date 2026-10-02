// Hand-written because the module it describes is plain CommonJS: it also runs
// as a script, so it cannot be TypeScript, but its spec is.
export declare function summarize(
  rawLog: string,
  exitCode: number,
  logPath: string,
): string;
export declare function logFileName(now: Date): string;
