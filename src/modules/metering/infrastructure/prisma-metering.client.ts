import type { PrismaClient } from '@prisma-client/client';

export type PrismaMeteringClient = PrismaClient & {
  close?: () => Promise<void>;
};
