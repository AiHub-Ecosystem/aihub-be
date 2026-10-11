import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';

import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { RUNTIME_CONNECTION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';

import {
  CONTROL_PLANE_PRISMA_CLIENT,
  CONTROL_PLANE_READ_PRISMA_CLIENT,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
  type SharedPrismaClients,
} from './application/persistence-client.port';
import { createSharedPrismaClients } from './infrastructure/prisma-client';

export {
  createPrismaClient,
  deferPrismaClient,
} from './infrastructure/prisma-client';

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
      useFactory: (configuration: {
        databaseUrl: string | undefined;
        controlPlaneDatabaseUrl: string | undefined;
        controlPlaneReadDatabaseUrl: string | undefined;
      }): SharedPrismaClients =>
        createSharedPrismaClients({
          databaseUrl: configuration.databaseUrl,
          controlPlaneDatabaseUrl: configuration.controlPlaneDatabaseUrl,
          controlPlaneReadDatabaseUrl:
            configuration.controlPlaneReadDatabaseUrl,
        }),
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
  ],
})
export class PersistenceModule {}
