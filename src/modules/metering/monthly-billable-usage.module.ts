import { Module } from '@nestjs/common';

import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import {
  MONTHLY_BILLABLE_USAGE,
  type MonthlyBillableUsagePort,
} from './application/monthly-billable-usage.port';
import { PostgresMonthlyBillableUsage } from './infrastructure/postgres-monthly-billable-usage';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: MONTHLY_BILLABLE_USAGE,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): MonthlyBillableUsagePort =>
        new PostgresMonthlyBillableUsage(runtime.prisma),
    },
  ],
  exports: [MONTHLY_BILLABLE_USAGE],
})
export class MonthlyBillableUsageModule {}
