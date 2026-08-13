import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { CallbacksModule } from './callbacks/callbacks.module';
import { HealthController } from './health/health.controller';
import { PawaPayModule } from './pawapay/pawapay.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ToolkitModule } from './toolkit/toolkit.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    AuthModule,
    PawaPayModule,
    WebhooksModule,
    TransactionsModule,
    CallbacksModule,
    ToolkitModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
