export function driftStatements(output: string): string[];

export function driftAgainstMigrations(options: {
  adminUrl: string;
  migrationsDir: string;
  schemaPath: string;
  scratchName?: string;
}): Promise<string[]>;

export function runDiffProcess(options: {
  command: string;
  args: string[];
  timeoutMs: number;
  phase: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string;
