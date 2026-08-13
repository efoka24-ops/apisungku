import { Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [WebhooksModule],
  controllers: [TransactionsController],
  providers: [PrismaService, TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
