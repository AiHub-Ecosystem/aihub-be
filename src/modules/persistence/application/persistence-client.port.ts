import type { PrismaClient } from '@prisma-client/client';

/**
 * The persistence seam (ADR-0088, #81).
 *
 * A module takes the client it needs from here rather than opening a pool, so
 * one process holds one pool per distinct database URL instead of one per
 * module. These tokens are the published way to ask for one; the clients behind
 * them are chosen by connection role, not by which module is asking.
 */

export const RUNTIME_PRISMA_CLIENT = Symbol('RUNTIME_PRISMA_CLIENT');
export const CONTROL_PLANE_PRISMA_CLIENT = Symbol(
  'CONTROL_PLANE_PRISMA_CLIENT',
);
export const CONTROL_PLANE_READ_PRISMA_CLIENT = Symbol(
  'CONTROL_PLANE_READ_PRISMA_CLIENT',
);

export interface PrismaPool {
  readonly options: {
    readonly max?: number | null | undefined;
    readonly connectionTimeoutMillis?: number | null | undefined;
    readonly idleTimeoutMillis?: number | null | undefined;
  };
  query(config: {
    readonly text: string;
    readonly query_timeout?: number;
  }): Promise<unknown>;
}

export interface PrismaClientHolder {
  /**
   * The generated client. Reading it before a URL is configured throws, which
   * is where a deployment missing a control-plane URL fails: assembling the
   * module graph must still work.
   */
  readonly prisma: PrismaClient;

  /**
   * The pool behind it. Exposed so infrastructure can reach the same
   * connections the client uses.
   */
  readonly pool: PrismaPool;

  /**
   * The readiness statement. It keeps `pg`'s per-query `query_timeout`, which
   * is what a health probe's budget has always been enforced with, rather than
   * a client call that carries no timeout of its own.
   */
  checkConnection(timeoutMs: number): Promise<void>;

  close(): Promise<void>;
}

export interface PrismaClientUrls {
  readonly databaseUrl: string | undefined;
  readonly controlPlaneDatabaseUrl: string | undefined;
  readonly controlPlaneReadDatabaseUrl: string | undefined;
}

export interface SharedPrismaClients {
  readonly runtime: PrismaClientHolder;
  readonly controlPlane: PrismaClientHolder;
  readonly controlPlaneRead: PrismaClientHolder;
  close(): Promise<void>;
}
