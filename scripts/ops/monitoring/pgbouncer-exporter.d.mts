import type { Server } from 'node:http';

export interface PgBouncerAggregate {
  readonly clients: readonly {
    readonly database: string;
    readonly state: string;
    readonly count: number;
  }[];
  readonly backends: readonly {
    readonly database: string;
    readonly state: string;
    readonly count: number;
  }[];
  readonly waiting: readonly {
    readonly database: string;
    readonly count: number;
  }[];
  readonly maxWait: readonly {
    readonly database: string;
    readonly seconds: number;
  }[];
}

export function databaseAliases(config: string): string[];
export function aggregatePgbouncerRows(
  clientRows: readonly Record<string, unknown>[],
  poolRows: readonly Record<string, unknown>[],
  aliases: readonly string[],
): PgBouncerAggregate;
export function createExporter(
  pool: {
    query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }>;
  },
  aliases: readonly string[],
): { readonly server: Server; readonly pool: unknown };
