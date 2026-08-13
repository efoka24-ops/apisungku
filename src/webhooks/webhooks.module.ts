import { Module } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { WebhooksDispatcher } from './webhooks.dispatcher';
import { WebhooksService } from './webhooks.service';

@Module({
  providers: [PrismaService, WebhooksService, WebhooksDispatcher],
  exports: [WebhooksService],
})
export class WebhooksModule {}
