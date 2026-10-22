import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';

import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { RUNTIME_CONNECTION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';

import {
  CONTROL_PLANE_PRISMA_CLIENT,
  CONTROL_PLANE_READ_PRISMA_CLIENT,
  EMAIL_DAILY_BUDGET_PRISMA_CLIENT,
  type PrismaClientHolder,
  type PrismaClientUrls,
  RUNTIME_PRISMA_CLIENT,
  type SharedPrismaClients,
} from './infrastructure/persistence-client';
import { createSharedPrismaClients } from './infrastructure/prisma-client';

const PRISMA_CLIENTS = Symbol('PRISMA_CLIENTS');

/**
 * Closes the pools on shutdown. Sharing a pool means sharing its close: three
 * roles over one URL end one pool, and that pool has to be ended once.
 */
class SharedPrismaClientsLifecycle implements OnApplicationShutdown {
  constructor(private readonly clients: SharedPrismaClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.close();
  }
}

@Global()
@Module({
  // Global because every module needs one, and importing this module into each
  // of them would say nothing the decorator has not already said.
  imports: [RuntimeConfigurationModule, SecretsModule],
  providers: [
    {
      provide: PRISMA_CLIENTS,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (configuration: PrismaClientUrls): SharedPrismaClients =>
        createSharedPrismaClients(configuration),
    },
    {
      provide: RUNTIME_PRISMA_CLIENT,
      inject: [PRISMA_CLIENTS],
      useFactory: (clients: SharedPrismaClients): PrismaClientHolder =>
        clients.runtime,
    },
    {
      provide: CONTROL_PLANE_PRISMA_CLIENT,
      inject: [PRISMA_CLIENTS],
      useFactory: (clients: SharedPrismaClients): PrismaClientHolder =>
        clients.controlPlane,
    },
    {
      provide: CONTROL_PLANE_READ_PRISMA_CLIENT,
      inject: [PRISMA_CLIENTS],
      useFactory: (clients: SharedPrismaClients): PrismaClientHolder =>
        clients.controlPlaneRead,
    },
    {
      provide: EMAIL_DAILY_BUDGET_PRISMA_CLIENT,
      inject: [PRISMA_CLIENTS],
      useFactory: (clients: SharedPrismaClients): PrismaClientHolder =>
        clients.emailDailyBudget,
    },
    {
      provide: SharedPrismaClientsLifecycle,
      inject: [PRISMA_CLIENTS],
      useFactory: (clients: SharedPrismaClients) =>
        new SharedPrismaClientsLifecycle(clients),
    },
  ],
  exports: [
    RUNTIME_PRISMA_CLIENT,
    CONTROL_PLANE_PRISMA_CLIENT,
    CONTROL_PLANE_READ_PRISMA_CLIENT,
    EMAIL_DAILY_BUDGET_PRISMA_CLIENT,
  ],
})
export class PersistenceModule {}

// The seam other modules compile against. A module file is the one place a
// business module may reach into another module's internals, so the tokens, the
// factory, and the raw-SQL helpers are re-exported here rather than imported
// from `infrastructure/` by path.
export {
  CONTROL_PLANE_PRISMA_CLIENT,
  CONTROL_PLANE_READ_PRISMA_CLIENT,
  EMAIL_DAILY_BUDGET_PRISMA_CLIENT,
  RUNTIME_PRISMA_CLIENT,
} from './infrastructure/persistence-client';
export type {
  PrismaClientHolder,
  PrismaPool,
} from './infrastructure/persistence-client';
export { createPrismaClient } from './infrastructure/prisma-client';
export {
  isLifecycleProperty,
  isRowlessWrite,
  normalizeRawRows,
  postgresError,
  runGuardedTransaction,
} from './infrastructure/prisma-raw';
export { createFixturePrismaClient } from './infrastructure/prisma-client';
