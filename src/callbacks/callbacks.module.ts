import { Module } from '@nestjs/common';

import { TransactionsModule } from '../transactions/transactions.module';
import { CallbacksController } from './callbacks.controller';

@Module({
  imports: [TransactionsModule],
  controllers: [CallbacksController],
})
export class CallbacksModule {}
