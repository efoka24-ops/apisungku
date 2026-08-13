import { Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [TransactionsModule],
  providers: [PrismaService, ReconciliationService],
})
export class ReconciliationModule {}
