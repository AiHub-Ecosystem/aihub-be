export function driftStatements(output: string): string[];

export function driftAgainstMigrations(options: {
  adminUrl: string;
  migrationsDir: string;
  schemaPath: string;
  scratchName?: string;
}): Promise<string[]>;
